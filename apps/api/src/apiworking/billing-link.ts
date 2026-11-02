import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { clinicScope, requirePatient } from '../patients/patient-access.js';
import type { PrismaDb } from '../prisma/client.js';

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
