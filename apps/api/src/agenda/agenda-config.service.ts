import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import type { RequestMeta } from '../common/utils/request-meta.js';
import { isUniqueViolation } from '../patients/patient-access.js';
import type { DbTx, PrismaDb } from '../prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';
import { formatHm, parseHm, WEEKDAY_LABELS } from './agenda-time.js';
import type {
  CreateRoomDto, CreateScheduleRuleDto, CreateServiceDto, CreateSpecialtyDto, DeactivateRuleDto, UpdateRoomDto, UpdateServiceDto, UpdateSpecialtyDto,
} from './dto/agenda.dto.js';

export interface Scope {
  clinicId: string;
  /** Sede fijada por el contexto (administradores de una sola sede); null = toda la clínica. */
  branchId: string | null;
}

export function agendaScope(actor: AuthPrincipal): Scope {
  const ctx = actor.context;
  if (!ctx || ctx.clinicId === null) throw new ForbiddenException('La agenda solo existe dentro del contexto de una clínica');
  return { clinicId: ctx.clinicId, branchId: ctx.branchId };
}

/** Un actor limitado a una sede solo opera en ella; si pide otra, 404 uniforme (no revela sedes). */
export function assertBranchAllowed(scope: Scope, branchId: string): void {
  if (scope.branchId && scope.branchId !== branchId) throw new NotFoundException('Sede no encontrada');
}

const DEFAULT_FROM = () => new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z');

/**
 * Configuración de la agenda: consultorios, especialidades, servicios (con duración), odontólogos (con sus
 * especialidades) y horarios recurrentes. Es configuración administrativa (permiso `agenda:manage`); cada cambio se
 * audita con nombres de campos. Nada se borra: se desactiva.
 */
@Injectable()
export class AgendaConfigService {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaDb,
    private readonly audit: AuditService,
  ) {}

  private rec(actor: AuthPrincipal, scope: Scope, meta: RequestMeta, action: string, entity: string, entityId: string | null, summary: Record<string, unknown>, tx?: DbTx) {
    return this.audit.record({ action, entity, entityId, userId: actor.user.id, clinicId: scope.clinicId, branchId: scope.branchId, meta, summary }, tx);
  }

  // ------------------------------------------------------------- consultorios

  async listRooms(actor: AuthPrincipal, branchId?: string) {
    const scope = agendaScope(actor);
    const rooms = await this.db.room.findMany({
      where: { clinicId: scope.clinicId, ...(scope.branchId ? { branchId: scope.branchId } : branchId ? { branchId } : {}) },
      orderBy: [{ branchId: 'asc' }, { name: 'asc' }],
    });
    return rooms.map((r) => ({ id: r.id, branchId: r.branchId, name: r.name, active: r.status === 'ACTIVE' }));
  }

  async createRoom(actor: AuthPrincipal, dto: CreateRoomDto, meta: RequestMeta) {
    const scope = agendaScope(actor);
    assertBranchAllowed(scope, dto.branchId);
    const branch = await this.db.branch.findFirst({ where: { id: dto.branchId, clinicId: scope.clinicId, status: 'ACTIVE' }, select: { id: true } });
    if (!branch) throw new NotFoundException('Sede no encontrada');
    try {
      const room = await this.db.$transaction(async (tx) => {
        const r = await tx.room.create({ data: { clinicId: scope.clinicId, branchId: dto.branchId, name: dto.name } });
        await this.rec(actor, scope, meta, 'AGENDA_ROOM_CREATED', 'Room', r.id, { fields: ['name'] }, tx);
        return r;
      });
      return { id: room.id, branchId: room.branchId, name: room.name, active: true };
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException('Ya existe un consultorio con ese nombre en la sede');
      throw e;
    }
  }

  async updateRoom(actor: AuthPrincipal, id: string, dto: UpdateRoomDto, meta: RequestMeta) {
    const scope = agendaScope(actor);
    const cur = await this.db.room.findFirst({ where: { id, clinicId: scope.clinicId } });
    if (!cur) throw new NotFoundException('Consultorio no encontrado');
    assertBranchAllowed(scope, cur.branchId);
    const data: Record<string, unknown> = {};
    const fields: string[] = [];
    if (dto.name !== undefined && dto.name !== cur.name) { data['name'] = dto.name; fields.push('name'); }
    if (dto.active !== undefined && (dto.active ? 'ACTIVE' : 'INACTIVE') !== cur.status) { data['status'] = dto.active ? 'ACTIVE' : 'INACTIVE'; fields.push('status'); }
    if (fields.length === 0) throw new BadRequestException('No hay cambios');
    try {
      const r = await this.db.$transaction(async (tx) => {
        const u = await tx.room.update({ where: { id }, data });
        await this.rec(actor, scope, meta, 'AGENDA_ROOM_UPDATED', 'Room', id, { fields }, tx);
        return u;
      });
      return { id: r.id, branchId: r.branchId, name: r.name, active: r.status === 'ACTIVE' };
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException('Ya existe un consultorio con ese nombre en la sede');
      throw e;
    }
  }

  // ------------------------------------------------------------ especialidades

  async listSpecialties(actor: AuthPrincipal) {
    const scope = agendaScope(actor);
    const rows = await this.db.specialty.findMany({ where: { clinicId: scope.clinicId }, orderBy: { name: 'asc' } });
    return rows.map((s) => ({ id: s.id, name: s.name, active: s.status === 'ACTIVE' }));
  }

  async createSpecialty(actor: AuthPrincipal, dto: CreateSpecialtyDto, meta: RequestMeta) {
    const scope = agendaScope(actor);
    try {
      const s = await this.db.$transaction(async (tx) => {
        const row = await tx.specialty.create({ data: { clinicId: scope.clinicId, name: dto.name } });
        await this.rec(actor, scope, meta, 'AGENDA_SPECIALTY_CREATED', 'Specialty', row.id, { fields: ['name'] }, tx);
        return row;
      });
      return { id: s.id, name: s.name, active: true };
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException('Ya existe una especialidad con ese nombre');
      throw e;
    }
  }

  async updateSpecialty(actor: AuthPrincipal, id: string, dto: UpdateSpecialtyDto, meta: RequestMeta) {
    const scope = agendaScope(actor);
    const cur = await this.db.specialty.findFirst({ where: { id, clinicId: scope.clinicId } });
    if (!cur) throw new NotFoundException('Especialidad no encontrada');
    const data: Record<string, unknown> = {};
    const fields: string[] = [];
    if (dto.name !== undefined && dto.name !== cur.name) { data['name'] = dto.name; fields.push('name'); }
    if (dto.active !== undefined && (dto.active ? 'ACTIVE' : 'INACTIVE') !== cur.status) { data['status'] = dto.active ? 'ACTIVE' : 'INACTIVE'; fields.push('status'); }
    if (fields.length === 0) throw new BadRequestException('No hay cambios');
    try {
      const s = await this.db.$transaction(async (tx) => {
        const u = await tx.specialty.update({ where: { id }, data });
        await this.rec(actor, scope, meta, 'AGENDA_SPECIALTY_UPDATED', 'Specialty', id, { fields }, tx);
        return u;
      });
      return { id: s.id, name: s.name, active: s.status === 'ACTIVE' };
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException('Ya existe una especialidad con ese nombre');
      throw e;
    }
  }

  // ----------------------------------------------------------------- servicios

  async listServices(actor: AuthPrincipal) {
    const scope = agendaScope(actor);
    const rows = await this.db.agendaService.findMany({ where: { clinicId: scope.clinicId }, include: { specialty: { select: { id: true, name: true } } }, orderBy: { name: 'asc' } });
    return rows.map((s) => ({ id: s.id, name: s.name, durationMinutes: s.durationMinutes, priceCents: s.priceCents, specialty: s.specialty, active: s.status === 'ACTIVE' }));
  }

  async createService(actor: AuthPrincipal, dto: CreateServiceDto, meta: RequestMeta) {
    const scope = agendaScope(actor);
    if (dto.durationMinutes % 5 !== 0) throw new BadRequestException('La duración debe ser múltiplo de 5 minutos');
    if (dto.specialtyId) await this.requireSpecialty(scope.clinicId, dto.specialtyId);
    try {
      const s = await this.db.$transaction(async (tx) => {
        const row = await tx.agendaService.create({ data: { clinicId: scope.clinicId, name: dto.name, durationMinutes: dto.durationMinutes, priceCents: dto.priceCents ?? null, specialtyId: dto.specialtyId ?? null } });
        await this.rec(actor, scope, meta, 'AGENDA_SERVICE_CREATED', 'AgendaService', row.id, { fields: ['name', 'durationMinutes', 'priceCents', 'specialtyId'] }, tx);
        return row;
      });
      return { id: s.id, name: s.name, durationMinutes: s.durationMinutes, active: true };
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException('Ya existe un servicio con ese nombre');
      throw e;
    }
  }

  async updateService(actor: AuthPrincipal, id: string, dto: UpdateServiceDto, meta: RequestMeta) {
    const scope = agendaScope(actor);
    const cur = await this.db.agendaService.findFirst({ where: { id, clinicId: scope.clinicId } });
    if (!cur) throw new NotFoundException('Servicio no encontrado');
    const data: Record<string, unknown> = {};
    const fields: string[] = [];
    if (dto.name !== undefined && dto.name !== cur.name) { data['name'] = dto.name; fields.push('name'); }
    if (dto.durationMinutes !== undefined && dto.durationMinutes !== cur.durationMinutes) {
      if (dto.durationMinutes % 5 !== 0) throw new BadRequestException('La duración debe ser múltiplo de 5 minutos');
      data['durationMinutes'] = dto.durationMinutes; fields.push('durationMinutes');
    }
    if (dto.priceCents !== undefined && dto.priceCents !== cur.priceCents) { data['priceCents'] = dto.priceCents; fields.push('priceCents'); }
    if (dto.specialtyId !== undefined && (dto.specialtyId ?? null) !== cur.specialtyId) {
      if (dto.specialtyId) await this.requireSpecialty(scope.clinicId, dto.specialtyId);
      data['specialtyId'] = dto.specialtyId ?? null; fields.push('specialtyId');
    }
    if (dto.active !== undefined && (dto.active ? 'ACTIVE' : 'INACTIVE') !== cur.status) { data['status'] = dto.active ? 'ACTIVE' : 'INACTIVE'; fields.push('status'); }
    if (fields.length === 0) throw new BadRequestException('No hay cambios');
    try {
      const s = await this.db.$transaction(async (tx) => {
        const u = await tx.agendaService.update({ where: { id }, data });
        await this.rec(actor, scope, meta, 'AGENDA_SERVICE_UPDATED', 'AgendaService', id, { fields }, tx);
        return u;
      });
      return { id: s.id, name: s.name, durationMinutes: s.durationMinutes, active: s.status === 'ACTIVE' };
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException('Ya existe un servicio con ese nombre');
      throw e;
    }
  }

  private async requireSpecialty(clinicId: string, id: string) {
    const s = await this.db.specialty.findFirst({ where: { id, clinicId, status: 'ACTIVE' }, select: { id: true } });
    if (!s) throw new NotFoundException('Especialidad no encontrada');
  }

  // -------------------------------------------------------------- odontólogos

  /** Odontólogos activos de la clínica (con asignación DENTIST vigente en la sede, si se indica). */
  async listDentists(actor: AuthPrincipal, branchId?: string) {
    const scope = agendaScope(actor);
    const bid = scope.branchId ?? branchId ?? null;
    const users = await this.db.user.findMany({
      where: {
        status: 'ACTIVE',
        assignments: { some: { clinicId: scope.clinicId, status: 'ACTIVE', role: { code: 'DENTIST' }, ...(bid ? { OR: [{ branchId: null }, { branchId: bid }] } : {}) } },
      },
      select: { id: true, firstName: true, lastName: true },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    });
    const specs = await this.db.dentistSpecialty.findMany({ where: { clinicId: scope.clinicId, userId: { in: users.map((u) => u.id) } }, include: { specialty: { select: { id: true, name: true } } } });
    return users.map((u) => ({
      userId: u.id,
      name: `${u.firstName} ${u.lastName}`,
      specialties: specs.filter((s) => s.userId === u.id).map((s) => s.specialty),
    }));
  }

  async setDentistSpecialties(actor: AuthPrincipal, userId: string, specialtyIds: string[], meta: RequestMeta) {
    const scope = agendaScope(actor);
    const dentists = await this.listDentists(actor);
    if (!dentists.some((d) => d.userId === userId)) throw new NotFoundException('Odontólogo no encontrado');
    const ids = [...new Set(specialtyIds)];
    const found = await this.db.specialty.count({ where: { clinicId: scope.clinicId, id: { in: ids }, status: 'ACTIVE' } });
    if (found !== ids.length) throw new NotFoundException('Especialidad no encontrada');
    await this.db.$transaction(async (tx) => {
      await tx.dentistSpecialty.deleteMany({ where: { clinicId: scope.clinicId, userId } });
      if (ids.length) await tx.dentistSpecialty.createMany({ data: ids.map((specialtyId) => ({ clinicId: scope.clinicId, userId, specialtyId })) });
      await this.rec(actor, scope, meta, 'AGENDA_DENTIST_SPECIALTIES_SET', 'User', userId, { count: ids.length }, tx);
    });
    return (await this.listDentists(actor)).find((d) => d.userId === userId)!;
  }

  // ----------------------------------------------------------------- horarios

  async listRules(actor: AuthPrincipal, q: { branchId?: string; dentistUserId?: string }) {
    const scope = agendaScope(actor);
    const rows = await this.db.scheduleRule.findMany({
      where: {
        clinicId: scope.clinicId, status: 'ACTIVE',
        ...(scope.branchId ? { branchId: scope.branchId } : q.branchId ? { branchId: q.branchId } : {}),
        ...(q.dentistUserId ? { dentistUserId: q.dentistUserId } : {}),
      },
      orderBy: [{ dentistUserId: 'asc' }, { weekday: 'asc' }, { startMinute: 'asc' }],
    });
    return rows.map((r) => ({
      id: r.id, branchId: r.branchId, dentistUserId: r.dentistUserId, roomId: r.roomId, weekday: r.weekday, weekdayLabel: WEEKDAY_LABELS[r.weekday],
      start: formatHm(r.startMinute), end: formatHm(r.endMinute), validFrom: r.validFrom.toISOString().slice(0, 10), validUntil: r.validUntil?.toISOString().slice(0, 10) ?? null,
    }));
  }

  /** Alta de un horario recurrente. Un odontólogo no puede tener dos horarios que se superpongan (ni en dos sedes a la vez). */
  async createRule(actor: AuthPrincipal, dto: CreateScheduleRuleDto, meta: RequestMeta) {
    const scope = agendaScope(actor);
    assertBranchAllowed(scope, dto.branchId);
    const start = parseHm(dto.start);
    const end = parseHm(dto.end);
    if (start >= end) throw new BadRequestException('La hora de inicio debe ser anterior a la de fin');
    const validFrom = dto.validFrom ?? DEFAULT_FROM().toISOString().slice(0, 10);
    if (dto.validUntil && dto.validUntil < validFrom) throw new BadRequestException('La vigencia termina antes de empezar');
    const branch = await this.db.branch.findFirst({ where: { id: dto.branchId, clinicId: scope.clinicId, status: 'ACTIVE' }, select: { id: true } });
    if (!branch) throw new NotFoundException('Sede no encontrada');
    await this.requireDentist(scope.clinicId, dto.dentistUserId, dto.branchId);
    if (dto.roomId) {
      const room = await this.db.room.findFirst({ where: { id: dto.roomId, branchId: dto.branchId, clinicId: scope.clinicId, status: 'ACTIVE' }, select: { id: true } });
      if (!room) throw new NotFoundException('Consultorio no encontrado');
    }
    const row = await this.db.$transaction(
      async (tx) => {
        // Serializa los horarios de un mismo odontólogo (evita dos altas superpuestas a la vez).
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${dto.dentistUserId} FOR UPDATE`;
        const same = await tx.scheduleRule.findMany({ where: { clinicId: scope.clinicId, dentistUserId: dto.dentistUserId, status: 'ACTIVE', weekday: dto.weekday } });
        const overlaps = same.some(
          (r) =>
            r.startMinute < end && start < r.endMinute &&
            (r.validUntil === null || r.validUntil.toISOString().slice(0, 10) >= validFrom) &&
            (dto.validUntil === undefined || r.validFrom.toISOString().slice(0, 10) <= dto.validUntil),
        );
        if (overlaps) throw new ConflictException({ message: 'El odontólogo ya tiene un horario que se superpone ese día', code: 'SCHEDULE_OVERLAP' });
        const created = await tx.scheduleRule.create({
          data: {
            clinicId: scope.clinicId, branchId: dto.branchId, dentistUserId: dto.dentistUserId, roomId: dto.roomId ?? null, weekday: dto.weekday,
            startMinute: start, endMinute: end, validFrom: new Date(`${validFrom}T00:00:00.000Z`), validUntil: dto.validUntil ? new Date(`${dto.validUntil}T00:00:00.000Z`) : null,
            createdById: actor.user.id,
          },
        });
        await this.rec(actor, scope, meta, 'AGENDA_SCHEDULE_CREATED', 'ScheduleRule', created.id, { weekday: dto.weekday, dentistUserId: dto.dentistUserId, branchId: dto.branchId }, tx);
        return created;
      },
      { isolationLevel: 'ReadCommitted' },
    );
    return { id: row.id };
  }

  async deactivateRule(actor: AuthPrincipal, id: string, dto: DeactivateRuleDto, meta: RequestMeta) {
    const scope = agendaScope(actor);
    const cur = await this.db.scheduleRule.findFirst({ where: { id, clinicId: scope.clinicId } });
    if (!cur) throw new NotFoundException('Horario no encontrado');
    assertBranchAllowed(scope, cur.branchId);
    if (cur.status === 'INACTIVE') return { id, active: false };
    await this.db.$transaction(async (tx) => {
      await tx.scheduleRule.update({ where: { id }, data: { status: 'INACTIVE' } });
      await this.rec(actor, scope, meta, 'AGENDA_SCHEDULE_DEACTIVATED', 'ScheduleRule', id, { reason: dto.reason }, tx);
    });
    return { id, active: false };
  }

  /** El usuario debe ser odontólogo activo de la clínica (y de la sede). */
  async requireDentist(clinicId: string, userId: string, branchId: string, db: DbTx | PrismaDb = this.db) {
    const ok = await db.user.count({
      where: { id: userId, status: 'ACTIVE', assignments: { some: { clinicId, status: 'ACTIVE', role: { code: 'DENTIST' }, OR: [{ branchId: null }, { branchId }] } } },
    });
    if (ok === 0) throw new NotFoundException('Odontólogo no encontrado');
  }
}
