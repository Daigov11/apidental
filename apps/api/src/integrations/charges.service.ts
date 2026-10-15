import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import type { RequestMeta } from '../common/utils/request-meta.js';
import { withTxRetry } from '../common/utils/tx-retry.js';
import { clinicScope, isUniqueViolation, requirePatient } from '../patients/patient-access.js';
import type { PrismaDb } from '../prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';
import { CHARGE_LABELS, METHOD_LABELS, money } from './billing-format.js';
import type { CreateChargeDto, ListChargesQuery, PayChargeDto, VoidChargeDto } from './dto/integrations.dto.js';
import { enqueueOutbox } from './outbox.service.js';
import { presentDocument } from './billing.service.js';

const INCLUDE = {
  patient: { select: { id: true, firstName: true, lastName: true, secondLastName: true } },
  documents: { orderBy: { number: 'desc' as const }, take: 1 },
} as const;
type Row = NonNullable<Awaited<ReturnType<ChargesService['raw']>>>;

const versionConflict = () => new ConflictException({ message: 'El cobro cambió mientras lo editaba; recargue e intente de nuevo', code: 'VERSION_CONFLICT' });

/**
 * Cobros de atenciones (administrativo: sin datos clínicos). El monto es inmutable (también en la base de datos).
 * Pagar encola, en la misma transacción, los puntos de fidelización y la solicitud de reseña (se omiten sin autorización
 * del paciente). Anular solo es posible mientras esté pendiente y sin comprobante.
 */
@Injectable()
export class ChargesService {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaDb,
    private readonly audit: AuditService,
  ) {}

  raw(clinicId: string, id: string) {
    return this.db.charge.findFirst({ where: { id, clinicId }, include: INCLUDE });
  }

  present(c: Row) {
    const doc = c.documents[0] ?? null;
    return {
      id: c.id,
      patient: { id: c.patient.id, name: [c.patient.firstName, c.patient.lastName, c.patient.secondLastName].filter(Boolean).join(' ') },
      appointmentId: c.appointmentId,
      description: c.description,
      amountCents: c.amountCents,
      amountText: money(c.amountCents),
      status: c.status,
      statusLabel: CHARGE_LABELS[c.status],
      paymentMethod: c.paymentMethod,
      paymentMethodLabel: c.paymentMethod ? METHOD_LABELS[c.paymentMethod] : null,
      paidAt: c.paidAt?.toISOString() ?? null,
      createdAt: c.createdAt.toISOString(),
      version: c.version,
      document: doc ? presentDocument(doc) : null,
      actions: {
        pay: c.status === 'PENDING',
        void: c.status === 'PENDING' && !doc,
        emitDocument: c.status === 'PAID' && (!doc || doc.status === 'REJECTED'),
      },
    };
  }

  async create(actor: AuthPrincipal, dto: CreateChargeDto, meta: RequestMeta) {
    const { clinicId, branchId: ctxBranch } = clinicScope(actor);
    await requirePatient(this.db, clinicId, dto.patientId, { active: true });
    let branchId: string;
    let description = dto.description;
    let amount = dto.amountCents;
    let appointmentId: string | null = null;
    if (dto.appointmentId) {
      const a = await this.db.appointment.findFirst({ where: { id: dto.appointmentId, clinicId, patientId: dto.patientId }, include: { service: true } });
      if (!a || (ctxBranch && a.branchId !== ctxBranch)) throw new NotFoundException('Cita no encontrada');
      if (a.status !== 'ATTENDED') throw new ConflictException({ message: 'Solo se cobra una cita ya atendida', code: 'APPOINTMENT_NOT_ATTENDED' });
      branchId = a.branchId;
      appointmentId = a.id;
      description ??= a.service.name;
      amount ??= a.service.priceCents ?? undefined;
      if (!amount) throw new BadRequestException('Indique el monto: el servicio no tiene precio de referencia');
    } else {
      const b = ctxBranch ?? dto.branchId;
      if (!b) throw new BadRequestException('Indique la sede del cobro');
      if (ctxBranch && dto.branchId && dto.branchId !== ctxBranch) throw new NotFoundException('Sede no encontrada');
      const branch = await this.db.branch.findFirst({ where: { id: b, clinicId, status: 'ACTIVE' }, select: { id: true } });
      if (!branch) throw new NotFoundException('Sede no encontrada');
      if (!description || !amount) throw new BadRequestException('Indique el concepto y el monto');
      branchId = b;
    }
    try {
      const row = await this.db.charge.create({
        data: { clinicId, branchId, patientId: dto.patientId, appointmentId, appointmentKey: appointmentId, description: description!, amountCents: amount!, createdById: actor.user.id },
      });
      await this.audit.record({ action: 'CHARGE_CREATED', entity: 'Charge', entityId: row.id, patientId: dto.patientId, userId: actor.user.id, clinicId, branchId, meta, summary: { amountCents: row.amountCents, appointmentId, simulated: true } });
      return this.get(actor, row.id);
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException({ message: 'Esa cita ya tiene un cobro vigente', code: 'CHARGE_EXISTS' });
      throw e;
    }
  }

  async get(actor: AuthPrincipal, id: string) {
    const { clinicId, branchId } = clinicScope(actor);
    const c = await this.raw(clinicId, id);
    if (!c || (branchId && c.branchId !== branchId)) throw new NotFoundException('Cobro no encontrado');
    return this.present(c);
  }

  async list(actor: AuthPrincipal, q: ListChargesQuery) {
    const { clinicId, branchId } = clinicScope(actor);
    const rows = await this.db.charge.findMany({
      where: { clinicId, ...(branchId ? { branchId } : {}), ...(q.patientId ? { patientId: q.patientId } : {}), ...(q.status ? { status: q.status } : {}) },
      include: INCLUDE, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: q.limit, skip: q.offset,
    });
    return rows.map((r) => this.present(r));
  }

  async pay(actor: AuthPrincipal, id: string, dto: PayChargeDto, meta: RequestMeta) {
    const { clinicId, branchId: ctxBranch } = clinicScope(actor);
    await this.get(actor, id);
    await withTxRetry(() =>
      this.db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM charges WHERE id = ${id} FOR UPDATE`;
          const c = await tx.charge.findFirstOrThrow({ where: { id, clinicId } });
          if (ctxBranch && c.branchId !== ctxBranch) throw new NotFoundException('Cobro no encontrado');
          if (c.status !== 'PENDING') throw new ConflictException({ message: `El cobro ya está ${CHARGE_LABELS[c.status].toLowerCase()}`, code: 'INVALID_TRANSITION' });
          if (c.version !== dto.expectedVersion) throw versionConflict();
          await tx.charge.update({ where: { id }, data: { status: 'PAID', paymentMethod: dto.method, paidAt: new Date(), paidById: actor.user.id, version: c.version + 1 } });
          // Mensajes para el proveedor en la MISMA transacción: si el pago se confirma, los mensajes existen.
          await enqueueOutbox(tx, { clinicId, kind: 'LOYALTY_ACCRUE', aggregateType: 'Charge', aggregateId: id, idempotencyKey: `loyalty-accrue:${id}` });
          await enqueueOutbox(tx, { clinicId, kind: 'REVIEW_REQUEST', aggregateType: 'Charge', aggregateId: id, idempotencyKey: `review:${id}` });
          await this.audit.record({ action: 'CHARGE_PAID', entity: 'Charge', entityId: id, patientId: c.patientId, userId: actor.user.id, clinicId, branchId: c.branchId, meta, summary: { method: dto.method, amountCents: c.amountCents, simulated: true } }, tx);
        },
        { isolationLevel: 'ReadCommitted' },
      ),
    );
    return this.get(actor, id);
  }

  async void(actor: AuthPrincipal, id: string, dto: VoidChargeDto, meta: RequestMeta) {
    const { clinicId, branchId: ctxBranch } = clinicScope(actor);
    await this.get(actor, id);
    await withTxRetry(() =>
      this.db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM charges WHERE id = ${id} FOR UPDATE`;
          const c = await tx.charge.findFirstOrThrow({ where: { id, clinicId } });
          if (ctxBranch && c.branchId !== ctxBranch) throw new NotFoundException('Cobro no encontrado');
          if (c.status !== 'PENDING') throw new ConflictException({ message: 'Solo se anula un cobro pendiente de pago', code: 'INVALID_TRANSITION' });
          if (c.version !== dto.expectedVersion) throw versionConflict();
          if ((await tx.billingDocument.count({ where: { chargeId: id } })) > 0) throw new ConflictException({ message: 'El cobro tiene comprobantes', code: 'HAS_DOCUMENTS' });
          await tx.charge.update({ where: { id }, data: { status: 'VOIDED', voidReason: dto.reason, appointmentKey: null, version: c.version + 1 } });
          await this.audit.record({ action: 'CHARGE_VOIDED', entity: 'Charge', entityId: id, patientId: c.patientId, userId: actor.user.id, clinicId, branchId: c.branchId, meta, summary: { reason: dto.reason, simulated: true } }, tx);
        },
        { isolationLevel: 'ReadCommitted' },
      ),
    );
    return this.get(actor, id);
  }
}
