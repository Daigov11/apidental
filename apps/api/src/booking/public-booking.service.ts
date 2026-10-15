import { BadRequestException, ConflictException, HttpException, HttpStatus, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { AgendaAvailabilityService } from '../agenda/agenda-availability.service.js';
import { addDays, limaToUtc, utcToLima } from '../agenda/agenda-time.js';
import { AuditService } from '../audit/audit.service.js';
import { AppConfig } from '../config/app-config.js';
import type { RequestMeta } from '../common/utils/request-meta.js';
import { isUniqueViolation } from '../patients/patient-access.js';
import type { PrismaDb } from '../prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';
import type { CreateBookingRequestDto, PublicAvailabilityQuery } from './booking.dto.js';

/** Margen mínimo: no se pide un horario que empieza en menos de 2 horas. */
const MIN_LEAD_MS = 2 * 3_600_000;
const MAX_DAYS_AHEAD = 60;
const MAX_RANGE_DAYS = 14;
const MAX_PENDING_PER_MOBILE = 3;
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sin 0/O/1/I/L: se dicta por teléfono

const minuteOf = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3));
const reference = () => 'SOL-' + Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
const money = (cents: number) => `S/ ${(cents / 100).toFixed(2)}`;

export function normalizeMobile(v: string): string | null {
  const d = v.replace(/[\s-]/g, '').replace(/^\+?51/, '');
  return /^9\d{8}$/.test(d) ? d : null;
}

/**
 * Web pública: información de la clínica, horarios libres y solicitudes de cita. NO crea pacientes ni citas: guarda una
 * solicitud que recepción atiende. Apagada (404) si no hay `PUBLIC_BOOKING_CLINIC_ID`. Nunca devuelve datos de personas.
 */
@Injectable()
export class PublicBookingService {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaDb,
    private readonly config: AppConfig,
    private readonly availability: AgendaAvailabilityService,
    private readonly audit: AuditService,
  ) {}

  private clinicId(): string {
    const id = this.config.publicBooking.clinicId;
    if (!id) throw new NotFoundException();
    return id;
  }

  async info() {
    const clinicId = this.clinicId();
    const clinic = await this.db.clinic.findUnique({ where: { id: clinicId }, select: { name: true, brandDisplayName: true } });
    if (!clinic) throw new NotFoundException();
    const [branches, services] = await Promise.all([
      this.db.branch.findMany({ where: { clinicId, status: 'ACTIVE' }, select: { id: true, name: true, address: true }, orderBy: { name: 'asc' } }),
      this.db.agendaService.findMany({ where: { clinicId, status: 'ACTIVE' }, select: { id: true, name: true, durationMinutes: true, priceCents: true }, orderBy: { name: 'asc' } }),
    ]);
    return {
      clinic: { name: clinic.brandDisplayName || clinic.name },
      branches,
      services: services.map((s) => ({ id: s.id, name: s.name, durationMinutes: s.durationMinutes, priceText: s.priceCents != null ? money(s.priceCents) : null })),
    };
  }

  private async offered(clinicId: string, branchId: string, serviceId: string, from: string, to: string) {
    const res = await this.availability.availabilityOfClinic(clinicId, { branchId, serviceId, from, to }, { minLeadMs: MIN_LEAD_MS });
    const byDay = new Map<string, Set<string>>();
    for (const s of res.slots) (byDay.get(s.date) ?? byDay.set(s.date, new Set()).get(s.date)!).add(s.time);
    return { durationMinutes: res.durationMinutes, byDay };
  }

  async availabilityOf(q: PublicAvailabilityQuery) {
    const clinicId = this.clinicId();
    const today = utcToLima(new Date()).date;
    const from = q.from < today ? today : q.from;
    const limit = addDays(today, MAX_DAYS_AHEAD);
    if (from > limit) return { durationMinutes: null, days: [] };
    let to = q.to ?? from;
    const maxTo = addDays(from, MAX_RANGE_DAYS - 1);
    if (to > maxTo) to = maxTo;
    if (to > limit) to = limit;
    if (to < from) throw new BadRequestException('El rango de fechas es inválido');
    const { durationMinutes, byDay } = await this.offered(clinicId, q.branchId, q.serviceId, from, to);
    const days = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, times]) => ({ date, times: [...times].sort() }));
    return { durationMinutes, days };
  }

  async create(dto: CreateBookingRequestDto, meta: RequestMeta) {
    const clinicId = this.clinicId();
    // Señuelo: un bot lo llena. Se responde como si hubiera funcionado, sin guardar nada.
    if (dto.website && dto.website.trim() !== '') return { reference: reference() };

    const mobile = normalizeMobile(dto.mobile);
    if (!mobile) throw new BadRequestException('El celular debe tener 9 dígitos y empezar con 9');
    const email = dto.email ? dto.email.toLowerCase() : null;
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new BadRequestException('Escriba un correo válido');
    let documentNumber: string | null = null;
    if (dto.documentNumber) {
      if (!dto.documentType) throw new BadRequestException('Indique el tipo de documento');
      documentNumber = dto.documentNumber.toUpperCase();
      const ok = dto.documentType === 'DNI' ? /^\d{8}$/.test(documentNumber) : /^[A-Z0-9]{6,20}$/.test(documentNumber);
      if (!ok) throw new BadRequestException(dto.documentType === 'DNI' ? 'El DNI tiene 8 dígitos' : 'El documento debe tener entre 6 y 20 letras o números');
    }

    if (Number.isNaN(Date.parse(`${dto.date}T00:00:00Z`))) throw new BadRequestException('La fecha no es válida');
    const minute = minuteOf(dto.time);
    if (minute >= 24 * 60 || minute % 5 !== 0) throw new BadRequestException('La hora no es válida');
    const startsAt = limaToUtc(dto.date, minute);
    const now = Date.now();
    if (startsAt.getTime() < now + MIN_LEAD_MS) throw new ConflictException({ message: 'Ese horario ya no está disponible. Elija otro.', code: 'SLOT_UNAVAILABLE' });
    if (dto.date > addDays(utcToLima(new Date()).date, MAX_DAYS_AHEAD)) throw new BadRequestException('Solo se puede pedir hasta dentro de 60 días');

    const [branch, service] = await Promise.all([
      this.db.branch.findFirst({ where: { id: dto.branchId, clinicId, status: 'ACTIVE' }, select: { id: true } }),
      this.db.agendaService.findFirst({ where: { id: dto.serviceId, clinicId, status: 'ACTIVE' }, select: { id: true } }),
    ]);
    if (!branch || !service) throw new NotFoundException('Sede o servicio no encontrado');

    // El horario pedido debe seguir libre para algún odontólogo (no se reserva: lo confirma recepción).
    const { byDay } = await this.offered(clinicId, dto.branchId, dto.serviceId, dto.date, dto.date);
    if (!byDay.get(dto.date)?.has(dto.time)) throw new ConflictException({ message: 'Ese horario ya no está disponible. Elija otro.', code: 'SLOT_UNAVAILABLE' });

    // Misma solicitud repetida (doble clic, reintento): se devuelve la existente.
    const same = await this.db.bookingRequest.findFirst({ where: { clinicId, mobile, serviceId: dto.serviceId, desiredStartsAt: startsAt, status: 'PENDING' }, select: { reference: true } });
    if (same) return { reference: same.reference };
    const pending = await this.db.bookingRequest.count({ where: { clinicId, mobile, status: 'PENDING' } });
    if (pending >= MAX_PENDING_PER_MOBILE) {
      throw new HttpException('Ya tiene solicitudes pendientes. La clínica se comunicará con usted; si es urgente, llámenos.', HttpStatus.TOO_MANY_REQUESTS);
    }

    for (let attempt = 0; attempt < 5; attempt++) {
      const ref = reference();
      try {
        const row = await this.db.bookingRequest.create({
          data: {
            reference: ref, clinicId, branchId: dto.branchId, serviceId: dto.serviceId, desiredStartsAt: startsAt,
            firstName: dto.firstName, lastName: dto.lastName, secondLastName: dto.secondLastName || null,
            documentType: documentNumber ? dto.documentType! : null, documentNumber, mobile, email, notes: dto.notes || null,
            privacyAcceptedAt: new Date(),
          },
          select: { id: true, reference: true },
        });
        await this.audit.recordSafely({
          action: 'BOOKING_REQUEST_CREATED', entity: 'BookingRequest', entityId: row.id, clinicId, branchId: dto.branchId, meta,
          summary: { serviceId: dto.serviceId, desiredStartsAt: startsAt.toISOString() },
        });
        return { reference: row.reference };
      } catch (e) {
        if (!isUniqueViolation(e)) throw e; // código repetido: otro intento
      }
    }
    throw new HttpException('No se pudo registrar la solicitud. Intente de nuevo.', HttpStatus.SERVICE_UNAVAILABLE);
  }
}
