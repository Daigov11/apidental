import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { agendaScope, assertBranchAllowed } from '../agenda/agenda-config.service.js';
import { utcToLima, formatHm } from '../agenda/agenda-time.js';
import { AppointmentsService } from '../agenda/appointments.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import type { RequestMeta } from '../common/utils/request-meta.js';
import type { PrismaDb } from '../prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';
import type { AcceptBookingRequestDto, ListBookingRequestsQuery, RejectBookingRequestDto } from './booking.dto.js';

const STATUS_LABEL = { PENDING: 'Pendiente', ACCEPTED: 'Atendida', REJECTED: 'Rechazada' } as const;

type Row = Awaited<ReturnType<BookingRequestsService['findRows']>>[number];

/** Solicitudes de la web pública, vistas por el personal con permiso de gestionar citas. Solo de su clínica (y sede, si está limitado a una). */
@Injectable()
export class BookingRequestsService {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaDb,
    private readonly audit: AuditService,
    private readonly appointments: AppointmentsService,
  ) {}

  private where(actor: AuthPrincipal) {
    const scope = agendaScope(actor);
    return { scope, base: { clinicId: scope.clinicId, ...(scope.branchId ? { branchId: scope.branchId } : {}) } };
  }

  findRows(where: object, limit: number) {
    return this.db.bookingRequest.findMany({
      where, take: limit, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { branch: { select: { id: true, name: true } }, service: { select: { id: true, name: true, durationMinutes: true } } },
    });
  }

  private present(r: Row) {
    const local = utcToLima(r.desiredStartsAt);
    return {
      id: r.id, reference: r.reference, status: r.status, statusLabel: STATUS_LABEL[r.status], createdAt: r.createdAt.toISOString(),
      branch: r.branch, service: r.service, desiredStartsAt: r.desiredStartsAt.toISOString(), date: local.date, time: formatHm(local.minute),
      person: { firstName: r.firstName, lastName: r.lastName, secondLastName: r.secondLastName, documentType: r.documentType, documentNumber: r.documentNumber, mobile: r.mobile, email: r.email },
      notes: r.notes, appointmentId: r.appointmentId, patientId: r.patientId, rejectReason: r.rejectReason, decidedAt: r.decidedAt?.toISOString() ?? null,
    };
  }

  async list(actor: AuthPrincipal, q: ListBookingRequestsQuery) {
    const { base } = this.where(actor);
    const status = q.status ?? 'PENDING';
    const rows = await this.findRows({ ...base, ...(status === 'ALL' ? {} : { status }) }, q.limit ?? 100);
    return rows.map((r) => this.present(r));
  }

  async count(actor: AuthPrincipal) {
    const { base } = this.where(actor);
    return { pending: await this.db.bookingRequest.count({ where: { ...base, status: 'PENDING' } }) };
  }

  private async load(actor: AuthPrincipal, id: string) {
    const { scope, base } = this.where(actor);
    const row = (await this.findRows({ ...base, id }, 1))[0];
    if (!row) throw new NotFoundException('Solicitud no encontrada');
    assertBranchAllowed(scope, row.branchId);
    return { row, scope };
  }

  /** Crea la cita con el flujo normal (mismas reglas y huecos) y marca la solicitud como atendida. */
  async accept(actor: AuthPrincipal, id: string, dto: AcceptBookingRequestDto, meta: RequestMeta) {
    const { row, scope } = await this.load(actor, id);
    if (row.status !== 'PENDING') throw new ConflictException('Esta solicitud ya fue atendida');
    const claimed = await this.db.bookingRequest.updateMany({
      where: { id, clinicId: scope.clinicId, status: 'PENDING' },
      data: { status: 'ACCEPTED', decidedById: actor.user.id, decidedAt: new Date(), patientId: dto.patientId },
    });
    if (claimed.count === 0) throw new ConflictException('Esta solicitud ya fue atendida');
    try {
      const appt = await this.appointments.create(actor, {
        patientId: dto.patientId, branchId: row.branchId, serviceId: row.serviceId, dentistUserId: dto.dentistUserId, startsAt: dto.startsAt, roomId: dto.roomId,
        notes: `Solicitud web ${row.reference}`,
      } as never, meta);
      await this.db.bookingRequest.update({ where: { id }, data: { appointmentId: appt.id } });
      await this.audit.record({
        action: 'BOOKING_REQUEST_ACCEPTED', entity: 'BookingRequest', entityId: id, patientId: dto.patientId, userId: actor.user.id, clinicId: scope.clinicId, branchId: row.branchId, meta,
        summary: { appointmentId: appt.id },
      });
      return appt;
    } catch (e) {
      // La cita no se pudo crear (horario ocupado, etc.): la solicitud vuelve a quedar pendiente.
      await this.db.bookingRequest.updateMany({ where: { id, status: 'ACCEPTED', appointmentId: null }, data: { status: 'PENDING', decidedById: null, decidedAt: null, patientId: null } });
      throw e;
    }
  }

  async reject(actor: AuthPrincipal, id: string, dto: RejectBookingRequestDto, meta: RequestMeta) {
    const { row, scope } = await this.load(actor, id);
    const res = await this.db.bookingRequest.updateMany({
      where: { id, clinicId: scope.clinicId, status: 'PENDING' },
      data: { status: 'REJECTED', rejectReason: dto.reason, decidedById: actor.user.id, decidedAt: new Date() },
    });
    if (res.count === 0) throw new ConflictException('Esta solicitud ya fue atendida');
    await this.audit.record({
      action: 'BOOKING_REQUEST_REJECTED', entity: 'BookingRequest', entityId: id, userId: actor.user.id, clinicId: scope.clinicId, branchId: row.branchId, meta, summary: { reasonLength: dto.reason.length },
    });
    return this.present((await this.findRows({ id }, 1))[0]!);
  }
}
