import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AuditAction, AuditService } from '../audit/audit.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import type { RequestMeta } from '../common/utils/request-meta.js';
import { withTxRetry } from '../common/utils/tx-retry.js';
import { ClinicalAllergyAssessmentService } from '../clinical/clinical-allergy-assessment.service.js';
import { isUniqueViolation, requirePatient } from '../patients/patient-access.js';
import type { DbTx, PrismaDb } from '../prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';
import { AgendaAvailabilityService } from './agenda-availability.service.js';
import { AgendaConfigService, agendaScope, assertBranchAllowed, type Scope } from './agenda-config.service.js';
import { ACTIVE_STATUSES, APPOINTMENT_LABELS, type AppointmentStatusCode } from './agenda-labels.js';
import { addMinutes, parseInstant, slotStarts, utcToLima } from './agenda-time.js';
import type {
  CreateAppointmentDto, ListAppointmentsQuery, ReasonVersionDto, RescheduleAppointmentDto, UpdateNotesDto, VersionDto,
} from './dto/agenda.dto.js';

/** Vigencia de la relación asistencial que nace de una cita: fin de la cita + 30 días [por validar]. */
export const APPOINTMENT_CARE_DAYS = 30;
/** El odontólogo puede abrir la atención desde 30 min antes del inicio y hasta 6 h después del fin. */
const START_EARLY_MS = 30 * 60_000;
const START_LATE_MS = 6 * 3_600_000;

const INCLUDE = {
  patient: { select: { id: true, firstName: true, lastName: true, secondLastName: true, contacts: { where: { type: 'MOBILE' as const, status: 'ACTIVE' as const }, orderBy: { isPrimary: 'desc' as const }, take: 1, select: { value: true } } } },
  dentist: { select: { id: true, firstName: true, lastName: true } },
  room: { select: { id: true, name: true } },
  service: { select: { id: true, name: true, durationMinutes: true } },
} as const;

type Loaded = NonNullable<Awaited<ReturnType<AppointmentsService['loadRaw']>>>;

const versionConflict = () => new ConflictException({ message: 'La cita cambió mientras la editaba; recargue e intente de nuevo', code: 'VERSION_CONFLICT' });
const invalidState = (status: AppointmentStatusCode) =>
  new ConflictException({ message: `La cita ya está ${APPOINTMENT_LABELS[status].toLowerCase()} y no admite este cambio`, code: 'INVALID_TRANSITION' });
const slotTaken = (what = 'El horario') => new ConflictException({ message: `${what} ya está ocupado; elija otro`, code: 'SLOT_TAKEN' });

class SeparationError extends Error {}

/**
 * Citas. Todas las escrituras corren en una transacción que (1) bloquea la cita, (2) libera/ocupa huecos de 5 minutos
 * del odontólogo y del consultorio. La clave primaria de `appointment_slots` es la barrera final contra la doble
 * reserva: aunque dos solicitudes pasen las verificaciones a la vez, la segunda falla con SLOT_TAKEN.
 * Recepción gestiona citas (administrativo); nunca obtiene acceso clínico: `start-attention` solo lo ejecuta el
 * odontólogo de la cita.
 */
@Injectable()
export class AppointmentsService {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaDb,
    private readonly audit: AuditService,
    private readonly config: AgendaConfigService,
    private readonly avail: AgendaAvailabilityService,
    private readonly assessment: ClinicalAllergyAssessmentService,
  ) {}

  // ------------------------------------------------------------------ lectura

  loadRaw(db: DbTx | PrismaDb, clinicId: string, id: string) {
    return db.appointment.findFirst({ where: { id, clinicId }, include: INCLUDE });
  }

  private async load(actor: AuthPrincipal, id: string, db: DbTx | PrismaDb = this.db): Promise<{ a: Loaded; scope: Scope }> {
    const scope = agendaScope(actor);
    const a = await this.loadRaw(db, scope.clinicId, id);
    if (!a || (scope.branchId && a.branchId !== scope.branchId)) throw new NotFoundException('Cita no encontrada');
    return { a, scope };
  }

  present(a: Loaded, actor: AuthPrincipal) {
    const now = Date.now();
    const active = (ACTIVE_STATUSES as readonly string[]).includes(a.status);
    const manage = actor.permissions.has('appointment:manage');
    const isDentist = a.dentistUserId === actor.user.id;
    const inWindow = now >= a.startsAt.getTime() - START_EARLY_MS && now <= a.endsAt.getTime() + START_LATE_MS;
    const clinicalView = actor.permissions.has('clinical:read') || actor.permissions.has('clinical:write');
    const local = utcToLima(a.startsAt);
    return {
      id: a.id,
      branchId: a.branchId,
      status: a.status,
      statusLabel: APPOINTMENT_LABELS[a.status],
      startsAt: a.startsAt.toISOString(),
      endsAt: a.endsAt.toISOString(),
      date: local.date,
      time: `${String(Math.floor(local.minute / 60)).padStart(2, '0')}:${String(local.minute % 60).padStart(2, '0')}`,
      durationMinutes: Math.round((a.endsAt.getTime() - a.startsAt.getTime()) / 60_000),
      patient: {
        id: a.patient.id,
        name: [a.patient.firstName, a.patient.lastName, a.patient.secondLastName].filter(Boolean).join(' '),
        mobile: a.patient.contacts[0]?.value ?? null,
      },
      dentist: { userId: a.dentist.id, name: `${a.dentist.firstName} ${a.dentist.lastName}` },
      room: a.room,
      service: a.service,
      notes: a.notes,
      cancelReason: a.cancelReason,
      noShowReason: a.noShowReason,
      rescheduledCount: a.rescheduledCount,
      confirmedAt: a.confirmedAt?.toISOString() ?? null,
      attendedAt: a.attendedAt?.toISOString() ?? null,
      version: a.version,
      // Solo perfiles clínicos ven el vínculo con la visita; recepción nunca.
      visitId: clinicalView ? a.visitId : undefined,
      hasVisit: a.visitId !== null,
      actions: {
        confirm: manage && a.status === 'RESERVED',
        reschedule: manage && active,
        cancel: manage && active,
        noShow: manage && active && a.startsAt.getTime() <= now,
        editNotes: manage && active,
        startAttention: active && isDentist && actor.permissions.has('appointment:attend') && actor.permissions.has('clinical:write') && inWindow,
        openVisit: a.status === 'ATTENDED' && isDentist && clinicalView,
      },
    };
  }

  async get(actor: AuthPrincipal, id: string) {
    const { a } = await this.load(actor, id);
    return this.present(a, actor);
  }

  async list(actor: AuthPrincipal, q: ListAppointmentsQuery) {
    const scope = agendaScope(actor);
    const from = q.from ? new Date(utcFrom(q.from)) : undefined;
    const to = q.to ? new Date(utcFrom(q.to, 1)) : undefined;
    const rows = await this.db.appointment.findMany({
      where: {
        clinicId: scope.clinicId,
        ...(scope.branchId ? { branchId: scope.branchId } : q.branchId ? { branchId: q.branchId } : {}),
        ...(q.dentistUserId ? { dentistUserId: q.dentistUserId } : {}),
        ...(q.roomId ? { roomId: q.roomId } : {}),
        ...(q.patientId ? { patientId: q.patientId } : {}),
        ...(q.status ? { status: q.status } : {}),
        ...(from || to ? { startsAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {}),
      },
      include: INCLUDE,
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      take: q.limit,
      skip: q.offset,
    });
    return rows.map((r) => this.present(r, actor));
  }

  // ----------------------------------------------------------------- creación

  async create(actor: AuthPrincipal, dto: CreateAppointmentDto, meta: RequestMeta) {
    const scope = agendaScope(actor);
    assertBranchAllowed(scope, dto.branchId);
    const startsAt = parseInstant(dto.startsAt, 'La fecha y hora de la cita');
    if (startsAt.getTime() < Date.now()) throw new BadRequestException('No se puede agendar en el pasado');
    if (dto.dentistUserId === actor.user.id) throw new ForbiddenException('No puede agendar citas a su propia agenda; lo debe hacer otra persona');
    await requirePatient(this.db, scope.clinicId, dto.patientId, { active: true });
    const branch = await this.db.branch.findFirst({ where: { id: dto.branchId, clinicId: scope.clinicId, status: 'ACTIVE' }, select: { id: true } });
    if (!branch) throw new NotFoundException('Sede no encontrada');
    const service = await this.db.agendaService.findFirst({ where: { id: dto.serviceId, clinicId: scope.clinicId, status: 'ACTIVE' } });
    if (!service) throw new NotFoundException('Servicio no encontrado');
    const duration = dto.durationMinutes ?? service.durationMinutes;
    if (duration % 5 !== 0) throw new BadRequestException('La duración debe ser múltiplo de 5 minutos');
    await this.assertDentistFor(scope.clinicId, dto.dentistUserId, dto.branchId, service.specialtyId);
    const endsAt = addMinutes(startsAt, duration);

    try {
      const created = await withTxRetry(() =>
        this.db.$transaction(
          async (tx) => {
            await this.assessment.lockPatient(tx, dto.patientId); // una sola cita a la vez por paciente
            const roomId = await this.reserve(tx, scope, { branchId: dto.branchId, dentistUserId: dto.dentistUserId, startsAt, endsAt, roomId: dto.roomId, patientId: dto.patientId });
            const row = await tx.appointment.create({
              data: {
                clinicId: scope.clinicId, branchId: dto.branchId, patientId: dto.patientId, dentistUserId: dto.dentistUserId, roomId, serviceId: dto.serviceId,
                startsAt, endsAt, notes: dto.notes || null, createdById: actor.user.id,
              },
            });
            await this.occupy(tx, scope.clinicId, row.id, dto.dentistUserId, roomId, startsAt, endsAt);
            await this.audit.record({
              action: 'APPOINTMENT_CREATED', entity: 'Appointment', entityId: row.id, patientId: dto.patientId, userId: actor.user.id, clinicId: scope.clinicId, branchId: dto.branchId, meta,
              summary: { dentistUserId: dto.dentistUserId, roomId, serviceId: dto.serviceId, startsAt: startsAt.toISOString(), durationMinutes: duration },
            }, tx);
            return row.id;
          },
          { isolationLevel: 'ReadCommitted' },
        ),
      );
      return this.get(actor, created);
    } catch (e) {
      if (isUniqueViolation(e)) throw slotTaken();
      throw e;
    }
  }

  // ----------------------------------------------------------- reprogramación

  async reschedule(actor: AuthPrincipal, id: string, dto: RescheduleAppointmentDto, meta: RequestMeta) {
    const { a: cur, scope } = await this.load(actor, id);
    const startsAt = dto.startsAt ? parseInstant(dto.startsAt, 'La nueva fecha y hora') : cur.startsAt;
    const dentistUserId = dto.dentistUserId ?? cur.dentistUserId;
    const serviceId = dto.serviceId ?? cur.serviceId;
    const duration = dto.durationMinutes ?? (dto.serviceId ? undefined : Math.round((cur.endsAt.getTime() - cur.startsAt.getTime()) / 60_000));
    if (startsAt.getTime() < Date.now()) throw new BadRequestException('No se puede reprogramar al pasado');
    if (dentistUserId !== cur.dentistUserId && dentistUserId === actor.user.id) throw new ForbiddenException('No puede agendar citas a su propia agenda; lo debe hacer otra persona');
    const service = serviceId === cur.serviceId ? await this.db.agendaService.findFirst({ where: { id: serviceId, clinicId: scope.clinicId } }) : await this.db.agendaService.findFirst({ where: { id: serviceId, clinicId: scope.clinicId, status: 'ACTIVE' } });
    if (!service) throw new NotFoundException('Servicio no encontrado');
    const minutes = duration ?? service.durationMinutes;
    if (minutes % 5 !== 0) throw new BadRequestException('La duración debe ser múltiplo de 5 minutos');
    const endsAt = addMinutes(startsAt, minutes);
    if (dentistUserId !== cur.dentistUserId || serviceId !== cur.serviceId) await this.assertDentistFor(scope.clinicId, dentistUserId, cur.branchId, service.specialtyId);

    try {
      await withTxRetry(() =>
        this.db.$transaction(
          async (tx) => {
            const row = await this.lock(tx, scope, id, dto.expectedVersion);
            await this.assessment.lockPatient(tx, row.patientId);
            await tx.appointmentSlot.deleteMany({ where: { ownerKind: 'APPOINTMENT', ownerId: id } });
            const roomId = await this.reserve(tx, scope, { branchId: row.branchId, dentistUserId, startsAt, endsAt, roomId: dto.roomId, preferredRoomId: row.roomId, patientId: row.patientId, ignoreAppointmentId: id });
            const unchanged = startsAt.getTime() === row.startsAt.getTime() && endsAt.getTime() === row.endsAt.getTime() && dentistUserId === row.dentistUserId && roomId === row.roomId && serviceId === row.serviceId;
            if (unchanged) throw new BadRequestException('No hay cambios en la cita');
            await tx.appointment.update({
              where: { id },
              data: { startsAt, endsAt, dentistUserId, roomId, serviceId, status: 'RESERVED', confirmedById: null, confirmedAt: null, rescheduledCount: { increment: 1 }, version: row.version + 1 },
            });
            await this.occupy(tx, scope.clinicId, id, dentistUserId, roomId, startsAt, endsAt);
            await this.audit.record({
              action: 'APPOINTMENT_RESCHEDULED', entity: 'Appointment', entityId: id, patientId: row.patientId, userId: actor.user.id, clinicId: scope.clinicId, branchId: row.branchId, meta,
              summary: { reason: dto.reason, from: row.startsAt.toISOString(), to: startsAt.toISOString(), dentistUserId, roomId },
            }, tx);
          },
          { isolationLevel: 'ReadCommitted' },
        ),
      );
    } catch (e) {
      if (isUniqueViolation(e)) throw slotTaken();
      throw e;
    }
    return this.get(actor, id);
  }

  // ------------------------------------------------------------- transiciones

  async confirm(actor: AuthPrincipal, id: string, dto: VersionDto, meta: RequestMeta) {
    const { scope } = await this.load(actor, id);
    await this.transition(actor, scope, id, dto.expectedVersion, 'CONFIRMED', meta, { confirmedById: actor.user.id, confirmedAt: new Date() }, 'APPOINTMENT_CONFIRMED', {});
    return this.get(actor, id);
  }

  async cancel(actor: AuthPrincipal, id: string, dto: ReasonVersionDto, meta: RequestMeta) {
    const { scope } = await this.load(actor, id);
    await this.transition(actor, scope, id, dto.expectedVersion, 'CANCELLED', meta, { cancelReason: dto.reason }, 'APPOINTMENT_CANCELLED', { reason: dto.reason }, true);
    return this.get(actor, id);
  }

  async markNoShow(actor: AuthPrincipal, id: string, dto: ReasonVersionDto, meta: RequestMeta) {
    const { a, scope } = await this.load(actor, id);
    if (a.startsAt.getTime() > Date.now()) throw new ConflictException({ message: 'Solo puede marcar ausencia cuando la hora de la cita ya llegó', code: 'TOO_EARLY' });
    await this.transition(actor, scope, id, dto.expectedVersion, 'NO_SHOW', meta, { noShowReason: dto.reason }, 'APPOINTMENT_NO_SHOW', { reason: dto.reason }, true);
    return this.get(actor, id);
  }

  async updateNotes(actor: AuthPrincipal, id: string, dto: UpdateNotesDto, meta: RequestMeta) {
    const { scope } = await this.load(actor, id);
    await withTxRetry(() =>
      this.db.$transaction(
        async (tx) => {
          const row = await this.lock(tx, scope, id, dto.expectedVersion);
          await tx.appointment.update({ where: { id }, data: { notes: dto.notes || null, version: row.version + 1 } });
          await this.audit.record({ action: 'APPOINTMENT_NOTES_UPDATED', entity: 'Appointment', entityId: id, patientId: row.patientId, userId: actor.user.id, clinicId: scope.clinicId, branchId: row.branchId, meta, summary: { hasNotes: Boolean(dto.notes) } }, tx);
        },
        { isolationLevel: 'ReadCommitted' },
      ),
    );
    return this.get(actor, id);
  }

  private async transition(
    actor: AuthPrincipal, scope: Scope, id: string, expectedVersion: number, to: AppointmentStatusCode, meta: RequestMeta,
    data: Record<string, unknown>, action: string, summary: Record<string, unknown>, release = false,
  ) {
    await withTxRetry(() =>
      this.db.$transaction(
        async (tx) => {
          const row = await this.lock(tx, scope, id, expectedVersion);
          await tx.appointment.update({ where: { id }, data: { ...data, status: to, version: row.version + 1 } });
          if (release) await tx.appointmentSlot.deleteMany({ where: { ownerKind: 'APPOINTMENT', ownerId: id } });
          await this.audit.record({ action, entity: 'Appointment', entityId: id, patientId: row.patientId, userId: actor.user.id, clinicId: scope.clinicId, branchId: row.branchId, meta, summary: { from: row.status, ...summary } }, tx);
        },
        { isolationLevel: 'ReadCommitted' },
      ),
    );
  }

  /** Bloquea la fila, valida versión y que siga activa (RESERVED/CONFIRMED). */
  private async lock(tx: DbTx, scope: Scope, id: string, expectedVersion: number) {
    await tx.$queryRaw`SELECT id FROM appointments WHERE id = ${id} FOR UPDATE`;
    const row = await tx.appointment.findFirst({ where: { id, clinicId: scope.clinicId } });
    if (!row || (scope.branchId && row.branchId !== scope.branchId)) throw new NotFoundException('Cita no encontrada');
    if (!(ACTIVE_STATUSES as readonly string[]).includes(row.status)) throw invalidState(row.status);
    if (row.version !== expectedVersion) throw versionConflict();
    return row;
  }

  // ------------------------------------------------------------------ huecos

  /** Verifica horario, odontólogo, consultorio y paciente libres; devuelve el consultorio a usar. */
  private async reserve(
    tx: DbTx, scope: Scope,
    p: { branchId: string; dentistUserId: string; startsAt: Date; endsAt: Date; roomId?: string; preferredRoomId?: string; patientId: string; ignoreAppointmentId?: string },
  ): Promise<string> {
    const lima = utcToLima(p.startsAt);
    if (utcToLima(new Date(p.endsAt.getTime() - 1)).date !== lima.date) throw new BadRequestException('La cita debe terminar el mismo día');
    const windows = await this.avail.windows(tx, scope.clinicId, p.branchId, [lima.date], p.dentistUserId);
    const window = this.avail.fitsWindow(windows, p.dentistUserId, p.startsAt, p.endsAt);
    if (!window) throw new ConflictException({ message: 'El odontólogo no atiende en ese horario', code: 'OUTSIDE_SCHEDULE' });
    const busy = await this.avail.busy(tx, scope.clinicId, p.startsAt, p.endsAt, p.ignoreAppointmentId);
    if (!this.avail.isFree(busy, 'DENTIST', p.dentistUserId, p.startsAt, p.endsAt)) throw slotTaken('El odontólogo en ese horario');
    let roomId: string | null;
    if (p.roomId) {
      const room = await tx.room.findFirst({ where: { id: p.roomId, clinicId: scope.clinicId, branchId: p.branchId, status: 'ACTIVE' }, select: { id: true } });
      if (!room) throw new NotFoundException('Consultorio no encontrado');
      if (!this.avail.isFree(busy, 'ROOM', room.id, p.startsAt, p.endsAt)) throw slotTaken('El consultorio en ese horario');
      roomId = room.id;
    } else {
      roomId = await this.avail.pickRoom(tx, scope.clinicId, p.branchId, busy, p.startsAt, p.endsAt, p.preferredRoomId ?? window.roomId);
      if (!roomId) throw new ConflictException({ message: 'No hay consultorios libres en ese horario', code: 'NO_ROOM' });
    }
    const overlap = await tx.appointment.count({
      where: { patientId: p.patientId, status: { in: [...ACTIVE_STATUSES] }, startsAt: { lt: p.endsAt }, endsAt: { gt: p.startsAt }, ...(p.ignoreAppointmentId ? { id: { not: p.ignoreAppointmentId } } : {}) },
    });
    if (overlap > 0) throw new ConflictException({ message: 'El paciente ya tiene una cita en ese horario', code: 'PATIENT_BUSY' });
    return roomId;
  }

  private async occupy(tx: DbTx, clinicId: string, appointmentId: string, dentistUserId: string, roomId: string, startsAt: Date, endsAt: Date) {
    const starts = slotStarts(startsAt, endsAt);
    const mk = (resourceKind: 'DENTIST' | 'ROOM', resourceId: string) => starts.map((slotStart) => ({ resourceKind, resourceId, slotStart, ownerKind: 'APPOINTMENT' as const, ownerId: appointmentId, clinicId }));
    // Orden estable (odontólogo y luego consultorio) para que dos transacciones no se bloqueen en círculo.
    await tx.appointmentSlot.createMany({ data: [...mk('DENTIST', dentistUserId), ...mk('ROOM', roomId)] });
  }

  private async assertDentistFor(clinicId: string, dentistUserId: string, branchId: string, specialtyId: string | null) {
    await this.config.requireDentist(clinicId, dentistUserId, branchId);
    if (specialtyId) {
      const has = await this.db.dentistSpecialty.count({ where: { clinicId, userId: dentistUserId, specialtyId } });
      if (has === 0) throw new ConflictException({ message: 'El odontólogo no atiende ese servicio', code: 'SERVICE_NOT_OFFERED' });
    }
  }

  // ------------------------------------------------------- inicio de atención

  /**
   * El odontólogo de la cita la abre: se crea (o reutiliza) la relación asistencial de origen CITA y se abre la visita,
   * todo en una transacción. Recepción no llega aquí (permiso `appointment:attend`); y quien agendó/confirmó la cita
   * debe ser distinto del odontólogo y de quien le otorgó el rol (separación de funciones).
   */
  async startAttention(actor: AuthPrincipal, id: string, meta: RequestMeta) {
    const { a: pre, scope } = await this.load(actor, id);
    if (pre.dentistUserId !== actor.user.id) throw new ForbiddenException('Solo el odontólogo de la cita puede iniciar la atención');
    if (actor.context?.branchId !== pre.branchId) throw new ConflictException({ message: 'Seleccione la sede de la cita para iniciar la atención', code: 'BRANCH_CONTEXT_REQUIRED' });
    const now = new Date();
    if (pre.status !== 'ATTENDED') {
      if (now.getTime() < pre.startsAt.getTime() - START_EARLY_MS) throw new ConflictException({ message: 'Aún es temprano para iniciar esta atención', code: 'TOO_EARLY' });
      if (now.getTime() > pre.endsAt.getTime() + START_LATE_MS) throw new ConflictException({ message: 'La cita ya venció; reprográmela', code: 'EXPIRED' });
    }
    try {
      const out = await withTxRetry(() =>
        this.db.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT id FROM appointments WHERE id = ${id} FOR UPDATE`;
            const a = await tx.appointment.findFirst({ where: { id, clinicId: scope.clinicId } });
            if (!a) throw new NotFoundException('Cita no encontrada');
            if (a.status === 'ATTENDED') return { visitId: a.visitId!, created: false, relationshipId: null as string | null };
            if (!(ACTIVE_STATUSES as readonly string[]).includes(a.status)) throw invalidState(a.status);

            // Bloqueo del odontólogo: serializa con retiro de rol y deshabilitación.
            const locked = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM users WHERE id = ${actor.user.id} FOR UPDATE`;
            const roles = locked[0]?.status === 'ACTIVE'
              ? await tx.userAssignment.findMany({
                  where: { userId: actor.user.id, clinicId: scope.clinicId, status: 'ACTIVE', role: { code: 'DENTIST' }, clinic: { is: { status: 'ACTIVE' } }, OR: [{ branchId: null }, { branchId: a.branchId }] },
                  select: { grantedById: true },
                })
              : [];
            if (roles.length === 0) throw new ForbiddenException('Su rol de odontólogo no está vigente en esta sede');
            const grantors = new Set(roles.map((r) => r.grantedById));
            const assigner = [a.createdById, a.confirmedById].find((u): u is string => !!u && u !== actor.user.id && !grantors.has(u));
            if (!assigner) throw new SeparationError();

            // Relación asistencial: reutiliza una vigente aplicable; si no, nace de esta cita.
            const rels = await tx.patientCareRelationship.findMany({
              where: { clinicId: scope.clinicId, patientId: a.patientId, dentistUserId: actor.user.id, status: 'ACTIVE', OR: [{ branchId: a.branchId }, { branchId: null }] },
            });
            const valid = rels.find((r) => !r.validUntil || r.validUntil > now);
            let relationshipId = valid?.id ?? null;
            let createdRel = false;
            if (!relationshipId) {
              for (const r of rels) {
                await tx.patientCareRelationship.update({ where: { id: r.id }, data: { status: 'ENDED', activeKey: null, endedAt: now, endedById: null, endKind: 'EXPIRED', endReason: 'Vigencia vencida' } });
              }
              const rel = await tx.patientCareRelationship.create({
                data: {
                  clinicId: scope.clinicId, patientId: a.patientId, dentistUserId: actor.user.id, branchId: a.branchId, source: 'APPOINTMENT', sourceRef: a.id, status: 'ACTIVE',
                  activeKey: `${a.patientId}|${actor.user.id}|${a.branchId}`, validUntil: addMinutes(a.endsAt, APPOINTMENT_CARE_DAYS * 24 * 60), reason: 'Atención de cita agendada', createdById: assigner,
                },
              });
              relationshipId = rel.id;
              createdRel = true;
              await this.audit.record({ action: AuditAction.CareRelationshipCreated, entity: 'PatientCareRelationship', entityId: rel.id, patientId: a.patientId, userId: actor.user.id, clinicId: scope.clinicId, branchId: a.branchId, meta, summary: { dentistUserId: actor.user.id, source: 'APPOINTMENT', appointmentId: a.id, assignedById: assigner } }, tx);
            }

            await this.assessment.lockPatient(tx, a.patientId);
            const last = await tx.clinicalVisit.aggregate({ where: { patientId: a.patientId }, _max: { visitNumber: true } });
            const visit = await tx.clinicalVisit.create({
              data: {
                clinicId: scope.clinicId, patientId: a.patientId, branchId: a.branchId, dentistUserId: actor.user.id, careRelationshipId: relationshipId, visitNumber: (last._max.visitNumber ?? 0) + 1,
                openKey: `${a.patientId}|${actor.user.id}`, appointmentId: a.id, createdById: actor.user.id,
              },
            });
            await tx.appointment.update({ where: { id }, data: { status: 'ATTENDED', visitId: visit.id, attendedAt: now, version: a.version + 1 } });
            await this.audit.record({ action: 'CLINICAL_VISIT_OPENED', entity: 'ClinicalVisit', entityId: visit.id, patientId: a.patientId, userId: actor.user.id, clinicId: scope.clinicId, branchId: a.branchId, meta, summary: { visitId: visit.id, visitNumber: visit.visitNumber, version: visit.version, via: 'appointment' } }, tx);
            await this.audit.record({ action: 'APPOINTMENT_ATTENDED', entity: 'Appointment', entityId: id, patientId: a.patientId, userId: actor.user.id, clinicId: scope.clinicId, branchId: a.branchId, meta, summary: { visitId: visit.id, careRelationshipCreated: createdRel } }, tx);
            return { visitId: visit.id, created: true, relationshipId };
          },
          { isolationLevel: 'ReadCommitted' },
        ),
      );
      const appointment = await this.get(actor, id);
      const visit = await this.db.clinicalVisit.findUnique({ where: { id: out.visitId }, select: { id: true, visitNumber: true, patientId: true } });
      return { appointment, visit: visit ? { id: visit.id, number: visit.visitNumber, patientId: visit.patientId } : null, alreadyStarted: !out.created };
    } catch (e) {
      if (e instanceof SeparationError) {
        await this.audit.recordSafely({ action: AuditAction.EscalationBlocked, entity: 'Appointment', entityId: id, patientId: pre.patientId, userId: actor.user.id, clinicId: scope.clinicId, branchId: pre.branchId, meta, summary: { reason: 'separation_of_duties', operation: 'appointment_start_attention' } });
        throw new ForbiddenException({ message: 'La cita fue agendada por quien le otorgó su rol o por usted; otra persona autorizada debe agendarla o confirmarla', code: 'SEPARATION_OF_DUTIES' });
      }
      if (isUniqueViolation(e)) throw new ConflictException({ message: 'Ya tiene una visita abierta con este paciente; ciérrela o cancélela antes', code: 'VISIT_ALREADY_OPEN' });
      throw e;
    }
  }
}

function utcFrom(date: string, plusDays = 0): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d + plusDays, 5, 0, 0, 0); // medianoche de Lima = 05:00 UTC
}
