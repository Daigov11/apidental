import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import type { RequestMeta } from '../common/utils/request-meta.js';
import { withTxRetry } from '../common/utils/tx-retry.js';
import { isUniqueViolation } from '../patients/patient-access.js';
import type { DbTx, PrismaDb } from '../prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';
import { AgendaConfigService, agendaScope, assertBranchAllowed } from './agenda-config.service.js';
import { APPOINTMENT_LABELS } from './agenda-labels.js';
import {
  addMinutes, daysBetween, formatHm, limaToUtc, OFFER_STEP_MINUTES, parseInstant, slotStarts, utcToLima, weekdayOfDate,
} from './agenda-time.js';
import type { AvailabilityQuery, CalendarQuery, CreateBlockDto, ReleaseBlockDto } from './dto/agenda.dto.js';

export interface Window {
  dentistUserId: string;
  roomId: string | null;
  date: string;
  start: Date;
  end: Date;
}

const MAX_RANGE_DAYS = 31;
const MAX_BLOCK_DAYS = 14;
const key = (kind: string, id: string, ms: number) => `${kind}|${id}|${ms}`;

export function checkRange(from: string, to: string | undefined): string[] {
  const end = to ?? from;
  if (end < from) throw new BadRequestException('El rango de fechas es inválido');
  const days = daysBetween(from, end);
  if (days.length > MAX_RANGE_DAYS) throw new BadRequestException(`El rango no puede superar ${MAX_RANGE_DAYS} días`);
  return days;
}

/**
 * Disponibilidad y calendario. Los horarios se derivan de las reglas recurrentes; lo ocupado son los huecos de 5
 * minutos de `appointment_slots` (citas y bloqueos). La tabla de huecos es además la que impide, en la base de datos,
 * que dos citas ocupen a la vez al mismo odontólogo o consultorio.
 */
@Injectable()
export class AgendaAvailabilityService {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaDb,
    private readonly audit: AuditService,
    private readonly config: AgendaConfigService,
  ) {}

  /** Ventanas de atención (reglas expandidas a fechas) de la sede en el rango. */
  async windows(db: DbTx | PrismaDb, clinicId: string, branchId: string, days: string[], dentistUserId?: string): Promise<Window[]> {
    const rules = await db.scheduleRule.findMany({
      where: { clinicId, branchId, status: 'ACTIVE', ...(dentistUserId ? { dentistUserId } : {}), validFrom: { lte: new Date(`${days[days.length - 1]}T00:00:00.000Z`) } },
    });
    const out: Window[] = [];
    for (const date of days) {
      const weekday = weekdayOfDate(date);
      for (const r of rules) {
        if (r.weekday !== weekday) continue;
        if (r.validFrom.toISOString().slice(0, 10) > date) continue;
        if (r.validUntil && r.validUntil.toISOString().slice(0, 10) < date) continue;
        out.push({ dentistUserId: r.dentistUserId, roomId: r.roomId, date, start: limaToUtc(date, r.startMinute), end: limaToUtc(date, r.endMinute) });
      }
    }
    return out.sort((a, b) => a.start.getTime() - b.start.getTime());
  }

  /** Huecos ocupados (por recurso) en un rango; `ignoreAppointmentId` excluye los de la cita que se reprograma. */
  async busy(db: DbTx | PrismaDb, clinicId: string, from: Date, to: Date, ignoreAppointmentId?: string): Promise<Set<string>> {
    const rows = await db.appointmentSlot.findMany({
      where: {
        clinicId, slotStart: { gte: from, lt: to },
        ...(ignoreAppointmentId ? { NOT: { ownerKind: 'APPOINTMENT', ownerId: ignoreAppointmentId } } : {}),
      },
      select: { resourceKind: true, resourceId: true, slotStart: true },
    });
    return new Set(rows.map((r) => key(r.resourceKind, r.resourceId, r.slotStart.getTime())));
  }

  isFree(busy: Set<string>, kind: 'DENTIST' | 'ROOM', id: string, start: Date, end: Date): boolean {
    for (const s of slotStarts(start, end)) if (busy.has(key(kind, id, s.getTime()))) return false;
    return true;
  }

  /** ¿Cabe [start,end) dentro de alguna ventana del odontólogo? */
  fitsWindow(windows: Window[], dentistUserId: string, start: Date, end: Date): Window | undefined {
    return windows.find((w) => w.dentistUserId === dentistUserId && w.start <= start && end <= w.end);
  }

  /** Consultorio libre para [start,end): primero el indicado, luego el habitual de la ventana, luego por nombre. */
  async pickRoom(db: DbTx | PrismaDb, clinicId: string, branchId: string, busy: Set<string>, start: Date, end: Date, preferred?: string | null, only?: string): Promise<string | null> {
    const rooms = await db.room.findMany({ where: { clinicId, branchId, status: 'ACTIVE', ...(only ? { id: only } : {}) }, orderBy: { name: 'asc' }, select: { id: true } });
    const order = rooms.map((r) => r.id).sort((a, b) => Number(b === preferred) - Number(a === preferred));
    return order.find((id) => this.isFree(busy, 'ROOM', id, start, end)) ?? null;
  }

  // -------------------------------------------------------------- disponibilidad

  async availability(actor: AuthPrincipal, q: AvailabilityQuery) {
    const scope = agendaScope(actor);
    assertBranchAllowed(scope, q.branchId);
    const days = checkRange(q.from, q.to);
    const branch = await this.db.branch.findFirst({ where: { id: q.branchId, clinicId: scope.clinicId, status: 'ACTIVE' }, select: { id: true } });
    if (!branch) throw new NotFoundException('Sede no encontrada');
    let duration = q.durationMinutes;
    if (q.serviceId) {
      const svc = await this.db.agendaService.findFirst({ where: { id: q.serviceId, clinicId: scope.clinicId, status: 'ACTIVE' } });
      if (!svc) throw new NotFoundException('Servicio no encontrado');
      duration ??= svc.durationMinutes;
    }
    if (!duration) throw new BadRequestException('Indique el servicio o la duración');
    const windows = await this.windows(this.db, scope.clinicId, q.branchId, days, q.dentistUserId);
    const from = limaToUtc(days[0]!, 0);
    const to = limaToUtc(days[days.length - 1]!, 24 * 60);
    const busy = await this.busy(this.db, scope.clinicId, from, to, q.ignoreAppointmentId);
    const rooms = await this.db.room.findMany({ where: { clinicId: scope.clinicId, branchId: q.branchId, status: 'ACTIVE', ...(q.roomId ? { id: q.roomId } : {}) }, select: { id: true }, orderBy: { name: 'asc' } });
    const now = Date.now();
    const slots: { date: string; time: string; startsAt: string; dentistUserId: string; roomIds: string[] }[] = [];
    for (const w of windows) {
      for (let t = w.start.getTime(); t + duration * 60_000 <= w.end.getTime(); t += OFFER_STEP_MINUTES * 60_000) {
        if (t < now) continue;
        const start = new Date(t);
        const end = addMinutes(start, duration);
        if (!this.isFree(busy, 'DENTIST', w.dentistUserId, start, end)) continue;
        const free = rooms.filter((r) => this.isFree(busy, 'ROOM', r.id, start, end)).map((r) => r.id);
        if (free.length === 0) continue;
        slots.push({ date: w.date, time: formatHm(utcToLima(start).minute), startsAt: start.toISOString(), dentistUserId: w.dentistUserId, roomIds: free });
      }
    }
    return { durationMinutes: duration, slots };
  }

  // ------------------------------------------------------------------ calendario

  async calendar(actor: AuthPrincipal, q: CalendarQuery) {
    const scope = agendaScope(actor);
    assertBranchAllowed(scope, q.branchId);
    const days = checkRange(q.from, q.to);
    const branch = await this.db.branch.findFirst({ where: { id: q.branchId, clinicId: scope.clinicId, status: 'ACTIVE' }, select: { id: true } });
    if (!branch) throw new NotFoundException('Sede no encontrada');
    const from = limaToUtc(days[0]!, 0);
    const to = limaToUtc(days[days.length - 1]!, 24 * 60);
    const [dentists, rooms, windows, blocks, appts] = await Promise.all([
      this.config.listDentists(actor, q.branchId),
      this.config.listRooms(actor, q.branchId),
      this.windows(this.db, scope.clinicId, q.branchId, days, q.dentistUserId),
      this.db.scheduleBlock.findMany({
        where: { clinicId: scope.clinicId, branchId: q.branchId, status: 'ACTIVE', startsAt: { lt: to }, endsAt: { gt: from }, ...(q.dentistUserId ? { OR: [{ dentistUserId: q.dentistUserId }, { dentistUserId: null }] } : {}) },
        orderBy: { startsAt: 'asc' },
      }),
      this.db.appointment.findMany({
        where: { clinicId: scope.clinicId, branchId: q.branchId, startsAt: { lt: to }, endsAt: { gt: from }, ...(q.dentistUserId ? { dentistUserId: q.dentistUserId } : {}), ...(q.roomId ? { roomId: q.roomId } : {}) },
        include: { patient: { select: { id: true, firstName: true, lastName: true, secondLastName: true } }, service: { select: { name: true } } },
        orderBy: { startsAt: 'asc' },
      }),
    ]);
    return {
      from: days[0], to: days[days.length - 1],
      dentists, rooms: rooms.filter((r) => r.active),
      windows: windows.map((w) => ({ dentistUserId: w.dentistUserId, roomId: w.roomId, date: w.date, startsAt: w.start.toISOString(), endsAt: w.end.toISOString() })),
      blocks: blocks.map((b) => ({ id: b.id, dentistUserId: b.dentistUserId, roomId: b.roomId, startsAt: b.startsAt.toISOString(), endsAt: b.endsAt.toISOString(), reason: b.reason })),
      appointments: appts.map((a) => ({
        id: a.id, dentistUserId: a.dentistUserId, roomId: a.roomId, startsAt: a.startsAt.toISOString(), endsAt: a.endsAt.toISOString(),
        status: a.status, statusLabel: APPOINTMENT_LABELS[a.status], service: a.service.name,
        patient: { id: a.patient.id, name: [a.patient.firstName, a.patient.lastName, a.patient.secondLastName].filter(Boolean).join(' ') },
      })),
    };
  }

  // ------------------------------------------------------------------- bloqueos

  async createBlock(actor: AuthPrincipal, dto: CreateBlockDto, meta: RequestMeta) {
    const scope = agendaScope(actor);
    assertBranchAllowed(scope, dto.branchId);
    if (!dto.dentistUserId && !dto.roomId) throw new BadRequestException('Indique el odontólogo o el consultorio que se bloquea');
    const startsAt = parseInstant(dto.startsAt, 'El inicio');
    const endsAt = parseInstant(dto.endsAt, 'El fin');
    if (endsAt <= startsAt) throw new BadRequestException('El fin debe ser posterior al inicio');
    if (endsAt.getTime() - startsAt.getTime() > MAX_BLOCK_DAYS * 86_400_000) throw new BadRequestException(`Un bloqueo no puede superar ${MAX_BLOCK_DAYS} días; cree varios`);
    if (endsAt.getTime() <= Date.now()) throw new BadRequestException('El bloqueo debe terminar en el futuro');
    const branch = await this.db.branch.findFirst({ where: { id: dto.branchId, clinicId: scope.clinicId, status: 'ACTIVE' }, select: { id: true } });
    if (!branch) throw new NotFoundException('Sede no encontrada');
    if (dto.dentistUserId) await this.config.requireDentist(scope.clinicId, dto.dentistUserId, dto.branchId);
    if (dto.roomId) {
      const room = await this.db.room.findFirst({ where: { id: dto.roomId, clinicId: scope.clinicId, branchId: dto.branchId }, select: { id: true } });
      if (!room) throw new NotFoundException('Consultorio no encontrado');
    }
    try {
      const block = await withTxRetry(() =>
        this.db.$transaction(
          async (tx) => {
            const b = await tx.scheduleBlock.create({
              data: { clinicId: scope.clinicId, branchId: dto.branchId, dentistUserId: dto.dentistUserId ?? null, roomId: dto.roomId ?? null, startsAt, endsAt, reason: dto.reason, createdById: actor.user.id },
            });
            const starts = slotStarts(startsAt, endsAt);
            const rows = [
              ...(dto.dentistUserId ? starts.map((s) => ({ resourceKind: 'DENTIST' as const, resourceId: dto.dentistUserId!, slotStart: s })) : []),
              ...(dto.roomId ? starts.map((s) => ({ resourceKind: 'ROOM' as const, resourceId: dto.roomId!, slotStart: s })) : []),
            ].map((r) => ({ ...r, ownerKind: 'BLOCK' as const, ownerId: b.id, clinicId: scope.clinicId }));
            for (let i = 0; i < rows.length; i += 1000) await tx.appointmentSlot.createMany({ data: rows.slice(i, i + 1000) });
            await this.audit.record({ action: 'AGENDA_BLOCK_CREATED', entity: 'ScheduleBlock', entityId: b.id, userId: actor.user.id, clinicId: scope.clinicId, branchId: dto.branchId, meta, summary: { reason: dto.reason, dentistUserId: dto.dentistUserId ?? null, roomId: dto.roomId ?? null } }, tx);
            return b;
          },
          { isolationLevel: 'ReadCommitted' },
        ),
      );
      return { id: block.id, startsAt: block.startsAt.toISOString(), endsAt: block.endsAt.toISOString(), reason: block.reason };
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException({ message: 'Hay citas u otros bloqueos en ese horario; reprograme o cancele primero', code: 'SLOT_TAKEN' });
      throw e;
    }
  }

  async releaseBlock(actor: AuthPrincipal, id: string, dto: ReleaseBlockDto, meta: RequestMeta) {
    const scope = agendaScope(actor);
    const cur = await this.db.scheduleBlock.findFirst({ where: { id, clinicId: scope.clinicId } });
    if (!cur) throw new NotFoundException('Bloqueo no encontrado');
    assertBranchAllowed(scope, cur.branchId);
    await withTxRetry(() =>
      this.db.$transaction(
        async (tx) => {
          const locked = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM schedule_blocks WHERE id = ${id} FOR UPDATE`;
          if (locked[0]?.status !== 'ACTIVE') throw new ConflictException('El bloqueo ya fue liberado');
          await tx.appointmentSlot.deleteMany({ where: { ownerKind: 'BLOCK', ownerId: id } });
          await tx.scheduleBlock.update({ where: { id }, data: { status: 'RELEASED', releasedAt: new Date(), releasedById: actor.user.id, releaseReason: dto.reason } });
          await this.audit.record({ action: 'AGENDA_BLOCK_RELEASED', entity: 'ScheduleBlock', entityId: id, userId: actor.user.id, clinicId: scope.clinicId, branchId: cur.branchId, meta, summary: { reason: dto.reason } }, tx);
        },
        { isolationLevel: 'ReadCommitted' },
      ),
    );
    return { id, released: true };
  }
}
