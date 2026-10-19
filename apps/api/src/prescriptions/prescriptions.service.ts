import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { AuditAction, AuditService } from '../audit/audit.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { ClinicalAccessService, type ClinicalIntent } from '../clinical/clinical-access.service.js';
import type { RequestMeta } from '../common/utils/request-meta.js';
import { withTxRetry } from '../common/utils/tx-retry.js';
import { INVITATION_DELIVERY, type InvitationDelivery } from '../invitations/delivery/invitation-delivery.js';
import { isUniqueViolation } from '../patients/patient-access.js';
import { fullName } from '../patients/patient-view.js';
import { ageOn } from '../patients/util/lima-date.js';
import type { PrismaDb } from '../prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';
import type { DeletePrescriptionDto, EmailPrescriptionDto, SavePrescriptionDto } from './prescriptions.dto.js';
import { renderPrescriptionPdf } from './prescription-pdf.js';

const code = (n: number) => `RX-${String(n).padStart(6, '0')}`;

type Row = {
  id: string;
  patientId: string;
  visitId: string | null;
  number: number;
  prescriberId: string;
  diagnosis: string | null;
  notes: string | null;
  status: string;
  deletedAt: Date | null;
  deleteReason: string | null;
  lastEmailedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  items: { position: number; medication: string; dose: string | null; frequency: string | null; duration: string | null; instructions: string | null }[];
};

function present(r: Row, prescriberName: string, patientName?: string) {
  return {
    id: r.id,
    number: code(r.number),
    patientId: r.patientId,
    ...(patientName !== undefined ? { patientName } : {}),
    visitId: r.visitId,
    prescriber: { id: r.prescriberId, name: prescriberName },
    diagnosis: r.diagnosis,
    notes: r.notes,
    status: r.status,
    deletedAt: r.deletedAt,
    deleteReason: r.deleteReason,
    lastEmailedAt: r.lastEmailedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    items: [...r.items]
      .sort((a, b) => a.position - b.position)
      .map((i) => ({ medication: i.medication, dose: i.dose, frequency: i.frequency, duration: i.duration, instructions: i.instructions })),
  };
}

const include = { items: true } as const;

/**
 * Recetas del paciente. Se emiten dentro de una atención o por fuera de ella, y se editan o eliminan sin cerrar la cita.
 * Toda operación pasa por el motor de acceso clínico (relación asistencial, auditoría). Eliminar es una baja lógica con motivo:
 * el registro se conserva y deja de aparecer. La auditoría guarda referencias y conteos; nunca los medicamentos ni el correo.
 * No sugiere medicamentos ni dosis: el contenido es siempre del profesional.
 */
@Injectable()
export class PrescriptionsService {
  private readonly logger = new Logger(PrescriptionsService.name);

  constructor(
    @Inject(PRISMA) private readonly db: PrismaDb,
    private readonly audit: AuditService,
    private readonly access: ClinicalAccessService,
    @Inject(INVITATION_DELIVERY) private readonly delivery: InvitationDelivery,
  ) {}

  private authorize(actor: AuthPrincipal, patientId: string, intent: ClinicalIntent, meta: RequestMeta) {
    return this.access.authorize(actor, patientId, intent, ['prescriptions'], meta, { allowLimited: false });
  }

  private async names(ids: string[]): Promise<Map<string, string>> {
    const users = await this.db.user.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, firstName: true, lastName: true } });
    return new Map(users.map((u) => [u.id, `${u.firstName} ${u.lastName}`]));
  }

  private async load(clinicId: string, patientId: string, id: string): Promise<Row> {
    const row = await this.db.prescription.findFirst({ where: { id, patientId, clinicId }, include });
    if (!row) throw new NotFoundException('Receta no encontrada');
    return row;
  }

  /** Editar o eliminar: su autor o la administración clínica. */
  private assertCanChange(actor: AuthPrincipal, row: Row) {
    if (row.status === 'DELETED') throw new ConflictException('La receta ya fue eliminada');
    if (row.prescriberId !== actor.user.id && !actor.permissions.has('clinical:admin')) {
      throw new ForbiddenException('Solo quien emitió la receta puede modificarla');
    }
  }

  async list(actor: AuthPrincipal, patientId: string, includeDeleted: boolean, meta: RequestMeta) {
    const d = await this.authorize(actor, patientId, 'read', meta);
    const rows = await this.db.prescription.findMany({
      where: { patientId, clinicId: d.clinicId, ...(includeDeleted ? {} : { status: 'ACTIVE' }) },
      include,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const names = await this.names(rows.map((r) => r.prescriberId));
    return rows.map((r) => present(r, names.get(r.prescriberId) ?? '—'));
  }

  /** Recetas recientes de la clínica (módulo «Recetas»). Odontólogos: las propias; vista/administración clínica: todas. */
  async listRecent(actor: AuthPrincipal, limit: number, offset: number, meta: RequestMeta) {
    const clinicId = actor.context?.clinicId;
    if (!clinicId) throw new ForbiddenException('Las recetas solo son accesibles dentro del contexto de una clínica');
    const all = actor.permissions.has('clinical:admin') || actor.permissions.has('clinical:view');
    const rows = await this.db.prescription.findMany({
      where: { clinicId, status: 'ACTIVE', ...(all ? {} : { prescriberId: actor.user.id }) },
      include: { ...include, patient: { select: { firstName: true, lastName: true, secondLastName: true } } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    });
    await this.audit.record({
      action: AuditAction.PrescriptionListed,
      entity: 'Prescription',
      userId: actor.user.id,
      clinicId,
      branchId: actor.context?.branchId ?? null,
      meta,
      summary: { count: rows.length, scope: all ? 'clinic' : 'own' },
    });
    const names = await this.names(rows.map((r) => r.prescriberId));
    return rows.map((r) => present(r, names.get(r.prescriberId) ?? '—', fullName(r.patient)));
  }

  async get(actor: AuthPrincipal, patientId: string, id: string, meta: RequestMeta) {
    const d = await this.authorize(actor, patientId, 'read', meta);
    const row = await this.load(d.clinicId, patientId, id);
    const names = await this.names([row.prescriberId]);
    return present(row, names.get(row.prescriberId) ?? '—');
  }

  async create(actor: AuthPrincipal, patientId: string, dto: SavePrescriptionDto, meta: RequestMeta) {
    const d = await this.authorize(actor, patientId, 'write', meta);
    const patient = await this.db.patient.findFirstOrThrow({ where: { id: patientId, clinicId: d.clinicId }, select: { status: true } });
    if (patient.status !== 'ACTIVE') throw new ConflictException('El paciente está inactivo; reactívelo para emitir recetas');
    if (dto.visitId) {
      const visit = await this.db.clinicalVisit.findFirst({ where: { id: dto.visitId, patientId, clinicId: d.clinicId }, select: { id: true } });
      if (!visit) throw new NotFoundException('Atención no encontrada para este paciente');
    }
    const id = await withTxRetry(async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await this.db.$transaction(async (tx) => {
            const last = await tx.prescription.findFirst({ where: { clinicId: d.clinicId }, orderBy: { number: 'desc' }, select: { number: true } });
            const row = await tx.prescription.create({
              data: {
                clinicId: d.clinicId,
                patientId,
                visitId: dto.visitId ?? null,
                number: (last?.number ?? 0) + 1,
                prescriberId: actor.user.id,
                diagnosis: dto.diagnosis ?? null,
                notes: dto.notes ?? null,
                items: { create: dto.items.map((i, position) => ({ position, ...itemData(i) })) },
              },
            });
            await this.audit.record(
              {
                action: AuditAction.PrescriptionCreated,
                entity: 'Prescription',
                entityId: row.id,
                patientId,
                userId: actor.user.id,
                clinicId: d.clinicId,
                branchId: d.branchId,
                meta,
                summary: { number: row.number, itemCount: dto.items.length, withVisit: Boolean(dto.visitId) },
              },
              tx,
            );
            return row.id;
          });
        } catch (error) {
          // Dos recetas simultáneas pueden pedir el mismo correlativo: la restricción única lo impide y se reintenta.
          if (isUniqueViolation(error) && attempt < 4) continue;
          throw error;
        }
      }
    });
    return this.get(actor, patientId, id, meta);
  }

  async update(actor: AuthPrincipal, patientId: string, id: string, dto: SavePrescriptionDto, meta: RequestMeta) {
    const d = await this.authorize(actor, patientId, 'write', meta);
    const row = await this.load(d.clinicId, patientId, id);
    this.assertCanChange(actor, row);
    await this.db.$transaction(async (tx) => {
      await tx.prescriptionItem.deleteMany({ where: { prescriptionId: id } });
      await tx.prescription.update({
        where: { id },
        data: {
          diagnosis: dto.diagnosis ?? null,
          notes: dto.notes ?? null,
          items: { create: dto.items.map((i, position) => ({ position, ...itemData(i) })) },
        },
      });
      await this.audit.record(
        {
          action: AuditAction.PrescriptionUpdated,
          entity: 'Prescription',
          entityId: id,
          patientId,
          userId: actor.user.id,
          clinicId: d.clinicId,
          branchId: d.branchId,
          meta,
          summary: { number: row.number, itemCount: dto.items.length },
        },
        tx,
      );
    });
    return this.get(actor, patientId, id, meta);
  }

  async remove(actor: AuthPrincipal, patientId: string, id: string, dto: DeletePrescriptionDto, meta: RequestMeta) {
    const d = await this.authorize(actor, patientId, 'write', meta);
    const row = await this.load(d.clinicId, patientId, id);
    this.assertCanChange(actor, row);
    await this.db.$transaction(async (tx) => {
      await tx.prescription.update({
        where: { id },
        data: { status: 'DELETED', deletedAt: new Date(), deletedById: actor.user.id, deleteReason: dto.reason },
      });
      await this.audit.record(
        {
          action: AuditAction.PrescriptionDeleted,
          entity: 'Prescription',
          entityId: id,
          patientId,
          userId: actor.user.id,
          clinicId: d.clinicId,
          branchId: d.branchId,
          meta,
          summary: { number: row.number, reason: dto.reason },
        },
        tx,
      );
    });
    return this.get(actor, patientId, id, meta);
  }

  private async render(clinicId: string, patientId: string, row: Row) {
    const [clinic, patient, names] = await Promise.all([
      this.db.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { name: true, brandDisplayName: true } }),
      this.db.patient.findFirstOrThrow({
        where: { id: patientId, clinicId },
        select: {
          firstName: true,
          lastName: true,
          secondLastName: true,
          birthDate: true,
          identifiers: { where: { status: 'ACTIVE' }, select: { type: true, number: true }, take: 1 },
          contacts: { where: { status: 'ACTIVE', type: 'EMAIL' }, select: { value: true, isPrimary: true } },
        },
      }),
      this.names([row.prescriberId]),
    ]);
    const clinicName = clinic.brandDisplayName ?? clinic.name;
    const number = code(row.number);
    const patientName = fullName(patient);
    const pdf = await renderPrescriptionPdf({
      clinicName,
      number,
      issuedAt: row.createdAt,
      patient: {
        fullName: patientName,
        document: patient.identifiers[0] ? `${patient.identifiers[0].type} ${patient.identifiers[0].number}` : null,
        age: patient.birthDate ? ageOn(patient.birthDate) : null,
      },
      prescriber: names.get(row.prescriberId) ?? '',
      diagnosis: row.diagnosis,
      notes: row.notes,
      items: [...row.items].sort((a, b) => a.position - b.position),
    });
    const primaryEmail = (patient.contacts.find((c) => c.isPrimary) ?? patient.contacts[0])?.value ?? null;
    return { pdf, clinicName, number, patientName, primaryEmail, fileName: `receta-${number}.pdf` };
  }

  async pdf(actor: AuthPrincipal, patientId: string, id: string, meta: RequestMeta) {
    const d = await this.authorize(actor, patientId, 'read', meta);
    const row = await this.load(d.clinicId, patientId, id);
    if (row.status === 'DELETED') throw new NotFoundException('Receta no encontrada');
    // La salida de datos personales se audita ANTES de entregar el documento.
    await this.audit.record({
      action: AuditAction.PrescriptionExported,
      entity: 'Prescription',
      entityId: id,
      patientId,
      userId: actor.user.id,
      clinicId: d.clinicId,
      branchId: d.branchId,
      meta,
      summary: { number: row.number },
    });
    const out = await this.render(d.clinicId, patientId, row);
    return { body: out.pdf, filename: out.fileName };
  }

  async email(actor: AuthPrincipal, patientId: string, id: string, dto: EmailPrescriptionDto, meta: RequestMeta) {
    const d = await this.authorize(actor, patientId, 'read', meta);
    const row = await this.load(d.clinicId, patientId, id);
    if (row.status === 'DELETED') throw new NotFoundException('Receta no encontrada');
    if (this.delivery.mode === 'disabled') {
      throw new ServiceUnavailableException('El envío por correo no está configurado en esta instalación');
    }
    const out = await this.render(d.clinicId, patientId, row);
    const to = (dto.to ?? out.primaryEmail)?.trim();
    if (!to) throw new UnprocessableEntityException('El paciente no tiene correo registrado; indique la dirección de destino');

    const outcome = await this.delivery.deliver({
      type: 'prescription',
      prescriptionId: id,
      toEmail: to,
      patientName: out.patientName,
      clinicName: out.clinicName,
      number: out.number,
      fileName: out.fileName,
      pdf: out.pdf,
    });
    const domain = to.split('@')[1] ?? '';
    await this.audit.record({
      action: AuditAction.PrescriptionEmailed,
      entity: 'Prescription',
      entityId: id,
      patientId,
      userId: actor.user.id,
      clinicId: d.clinicId,
      branchId: d.branchId,
      meta,
      summary: { number: row.number, delivered: outcome.ok, domain, ...(outcome.ok ? {} : { reason: outcome.reason }) },
    });
    if (!outcome.ok) {
      this.logger.warn({ msg: 'No se pudo entregar la receta por correo', prescriptionId: id, reason: outcome.reason });
      throw new ServiceUnavailableException('No se pudo enviar el correo. Intente de nuevo en unos minutos.');
    }
    await this.db.prescription.update({ where: { id }, data: { lastEmailedAt: new Date() } });
    // En desarrollo el canal es un buzón en memoria: se avisa para que nadie crea que llegó a un correo real.
    return { sent: true, to, simulated: this.delivery.mode === 'dev' };
  }
}

function itemData(i: SavePrescriptionDto['items'][number]) {
  return {
    medication: i.medication,
    dose: i.dose ?? null,
    frequency: i.frequency ?? null,
    duration: i.duration ?? null,
    instructions: i.instructions ?? null,
  };
}
