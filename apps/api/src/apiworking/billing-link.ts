import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { clinicScope, requirePatient } from '../patients/patient-access.js';
import type { DbTx, PrismaDb } from '../prisma/client.js';

/** Estados de una venta que ocupan la cita: una sola venta vigente por cita. */
export const LIVE_SALE_STATUSES = ['PENDING', 'SENT', 'PENDING_RECONCILIATION', 'PENDING_ISSUE'] as const;

/**
 * Paciente y cita de una venta. Si hay cita, debe estar ATTENDED, ser de la sede de quien opera y no tener ya otra venta vigente;
 * el paciente es el de la cita. `excludeSaleId` es la venta pendiente que se está emitiendo (no cuenta como «ya cobrada»).
 */
export async function resolveBillingLink(db: PrismaDb, principal: AuthPrincipal, input: { patientId?: string; appointmentId?: string; excludeSaleId?: string }) {
  const { clinicId, branchId } = clinicScope(principal);
  let patientId = input.patientId ?? null;
  const appointmentId = input.appointmentId ?? null;
  if (appointmentId) {
    const a = await db.appointment.findFirst({ where: { id: appointmentId, clinicId }, select: { id: true, patientId: true, branchId: true, status: true } });
    if (!a || (branchId && a.branchId !== branchId)) throw new NotFoundException('Cita no encontrada');
    if (a.status !== 'ATTENDED') throw new ConflictException({ message: 'Solo se cobra una cita ya atendida', code: 'APPOINTMENT_NOT_ATTENDED' });
    if (patientId && patientId !== a.patientId) throw new BadRequestException('El paciente no corresponde a la cita');
    patientId = a.patientId;
    const live = await db.apiworkingSale.findFirst({
      where: { appointmentId, docStatus: { in: [...LIVE_SALE_STATUSES] }, ...(input.excludeSaleId ? { id: { not: input.excludeSaleId } } : {}) },
      select: { id: true },
    });
    if (live) throw new ConflictException({ message: 'Esa cita ya tiene una venta vigente', code: 'APPOINTMENT_ALREADY_BILLED' });
  } else if (patientId) {
    await requirePatient(db, clinicId, patientId);
  }
  return { patientId, appointmentId };
}

/**
 * Servicios de la cuenta pendiente que se cobran en una venta: del mismo paciente, vigentes, sin cobrar y de una consulta ya
 * terminada (visita cerrada). Cualquier otro id es un error: no se cobra algo que no corresponde.
 */
export async function requirePendingServices(db: PrismaDb | DbTx, clinicId: string, patientId: string | null, ids: readonly string[] | undefined): Promise<string[]> {
  const unique = [...new Set(ids ?? [])];
  if (unique.length === 0) return [];
  if (!patientId) throw new BadRequestException('Para cobrar servicios de una atención indique el paciente');
  const ok = await db.visitService.count({ where: { id: { in: unique }, clinicId, patientId, status: 'ACTIVE', saleId: null, visit: { status: 'CLOSED' } } });
  if (ok !== unique.length) throw new ConflictException({ message: 'Algún servicio ya se cobró o no está pendiente: actualice la cuenta del paciente', code: 'SERVICES_NOT_PENDING' });
  return unique;
}

/** Marca los servicios como cobrados por la venta (solo los que siguen pendientes). */
export async function markServicesBilled(db: PrismaDb | DbTx, clinicId: string, saleId: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.visitService.updateMany({ where: { id: { in: [...ids] }, clinicId, saleId: null, status: 'ACTIVE' }, data: { saleId } });
}

/** Una venta que finalmente no existe (rechazada o conciliada como no registrada) devuelve sus servicios a la cuenta pendiente. */
export async function releaseServices(db: PrismaDb | DbTx, saleId: string): Promise<void> {
  await db.visitService.updateMany({ where: { saleId }, data: { saleId: null } });
}
