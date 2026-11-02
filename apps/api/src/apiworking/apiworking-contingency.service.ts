import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AuditAction, AuditService } from '../audit/audit.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { CashboxService } from '../cashbox/cashbox.service.js';
import { CashFlowDto } from '../cashbox/cashbox.dto.js';
import type { RequestMeta } from '../common/utils/request-meta.js';
import { AppConfig } from '../config/app-config.js';
import { clinicScope, isUniqueViolation } from '../patients/patient-access.js';
import type { PrismaDb } from '../prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';
import { LIVE_SALE_STATUSES, resolveBillingLink } from './billing-link.js';
import { ApiworkingClientsService } from './apiworking-clients.service.js';
import { presentSale } from './apiworking-sales.service.js';
import type { ContingencyDto } from './dto/apiworking.dto.js';

const IDENTIFIER_TO_DOC_TYPE = { DNI: '1', CE: '4', PASSPORT: '7' } as const;
const IDENTIFIER_LABEL = { DNI: 'DNI', CE: 'Carné de extranjería', PASSPORT: 'Pasaporte' } as const;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const limaToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());

/**
 * Cobro de contingencia: Apiworking es la caja real; si no responde, el cobro se guarda aquí (venta «por emitir») y el dinero entra en la
 * caja LOCAL. El documento se emite después, a mano y con aprobación (nunca de forma automática). Un comprobante interno NO es un comprobante
 * de SUNAT: la Boleta o Factura sigue pendiente hasta emitirla en Apiworking.
 */
@Injectable()
export class ApiworkingContingencyService {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaDb,
    private readonly config: AppConfig,
    private readonly audit: AuditService,
    private readonly clients: ApiworkingClientsService,
    private readonly cashbox: CashboxService,
  ) {}

  /** Datos para cobrar desde una cita atendida o desde un paciente: cliente por su documento, servicio y precio de referencia. */
  async billingDraft(principal: AuthPrincipal, q: { appointmentId?: string; patientId?: string }) {
    const { clinicId } = clinicScope(principal);
    if (!q.appointmentId && !q.patientId) throw new BadRequestException('Indique la cita o el paciente');
    const appointment = q.appointmentId
      ? await this.db.appointment.findFirst({ where: { id: q.appointmentId, clinicId }, include: { service: { select: { name: true, priceCents: true } } } })
      : null;
    if (q.appointmentId && !appointment) throw new NotFoundException('Cita no encontrada');
    const patientId = appointment?.patientId ?? q.patientId!;
    const patient = await this.db.patient.findFirst({ where: { id: patientId, clinicId }, select: { id: true, firstName: true, lastName: true, secondLastName: true } });
    if (!patient) throw new NotFoundException('Paciente no encontrado');
    const identifier = await this.db.patientIdentifier.findFirst({ where: { patientId, clinicId, status: 'ACTIVE' }, select: { type: true, number: true }, orderBy: { createdAt: 'desc' } });
    const customer = identifier ? await this.clients.findByDocument(principal, identifier.number) : null;
    const billed = appointment
      ? await this.db.apiworkingSale.findFirst({ where: { appointmentId: appointment.id, docStatus: { in: [...LIVE_SALE_STATUSES] } }, orderBy: { createdAt: 'desc' } })
      : null;
    return {
      patient: { id: patient.id, name: [patient.firstName, patient.lastName, patient.secondLastName].filter(Boolean).join(' ') },
      appointment: appointment ? { id: appointment.id, status: appointment.status } : null,
      description: appointment?.service.name ?? null,
      amountCents: appointment?.service.priceCents ?? null,
      identifier: identifier ? { docType: IDENTIFIER_TO_DOC_TYPE[identifier.type], docTypeLabel: IDENTIFIER_LABEL[identifier.type], docNumber: identifier.number } : null,
      customer,
      alreadyBilled: billed ? presentSale(billed) : null,
      canBill: appointment ? appointment.status === 'ATTENDED' && !billed : true,
    };
  }

  async record(principal: AuthPrincipal, dto: ContingencyDto, meta: RequestMeta) {
    const { clinicId } = clinicScope(principal);
    const replay = await this.db.apiworkingSale.findUnique({ where: { idempotencyKey: dto.requestKey } });
    if (replay) {
      if (replay.clinicId !== clinicId) throw new ConflictException({ message: 'La clave ya se usó con otra venta', code: 'IDEMPOTENCY_MISMATCH' });
      return presentSale(replay);
    }
    const customer = await this.clients.findLocal(principal, dto.customerId);
    if (!customer) throw new BadRequestException('El cliente no está guardado en este sistema: créelo o úselo en una venta mientras Apiworking responde');
    const link = await resolveBillingLink(this.db, principal, { patientId: dto.patientId, appointmentId: dto.appointmentId });
    const totalCents = dto.lines.reduce((sum, l) => sum + l.quantity * l.unitPriceCents, 0);
    if (totalCents < 1 || totalCents > 1_000_000_000) throw new BadRequestException('El total está fuera de rango');
    const docDate = dto.docDate ?? limaToday();
    if (Number.isNaN(Date.parse(`${docDate}T00:00:00Z`))) throw new BadRequestException('Fecha inválida');

    // El dinero entra primero en la caja local: si está cerrada (o la cuenta no existe), no se registra nada.
    const movement = (await this.cashbox.create(principal, {
      flow: CashFlowDto.INCOME,
      accountId: dto.accountId,
      categoryId: dto.categoryId,
      description: `Cobro en contingencia: ${dto.description}`.slice(0, 200),
      amountCents: totalCents,
      requestKey: dto.requestKey,
    }, meta)) as { id: string };

    try {
      const sale = await this.db.apiworkingSale.create({
        data: {
          clinicId,
          tenant: this.config.apiworking.expectedDatabase!,
          idempotencyKey: dto.requestKey,
          requestHash: sha256(JSON.stringify({ contingency: true, customer: customer.id, lines: dto.lines, totalCents })),
          patientId: link.patientId,
          appointmentId: link.appointmentId,
          contingency: true,
          cashMovementId: movement.id,
          externalCustomerId: customer.id,
          customerName: customer.name.slice(0, 200),
          customerDocType: customer.docType.slice(0, 20),
          customerDocNumber: customer.docNumber.slice(0, 20),
          // Lo de Apiworking (caja, tipo, serie y forma de pago) se elige al emitir: ahora no se puede consultar.
          idCaja: '',
          idSerie: '',
          documentTypeId: '',
          paymentMethodId: '',
          description: dto.description,
          lines: dto.lines.map((l) => ({ name: l.name, quantity: l.quantity, unitPriceCents: l.unitPriceCents })),
          totalCents,
          docDate: new Date(`${docDate}T00:00:00Z`),
          docStatus: 'PENDING_ISSUE',
          createdById: principal.user.id,
        },
      });
      await this.audit.record({ action: AuditAction.ApiworkingContingencyRecorded, entity: 'ApiworkingSale', entityId: sale.id, userId: principal.user.id, clinicId, patientId: link.patientId, meta, summary: { totalCents, cashMovementId: movement.id } });
      return presentSale(sale);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await this.db.apiworkingSale.findUnique({ where: { idempotencyKey: dto.requestKey } });
      if (!raced) throw error;
      return presentSale(raced);
    }
  }
}
