import { ForbiddenException, NotFoundException, ConflictException } from '@nestjs/common';
import type { AuthPrincipal } from '../auth/auth.types.js';
import type { DbTx, PrismaDb } from '../prisma/client.js';

export interface ClinicScope {
  clinicId: string;
  /** Sede del contexto activo (informativa: el paciente pertenece a la clínica, no a la sede). */
  branchId: string | null;
}

/**
 * Los datos de pacientes se operan SIEMPRE dentro de una clínica. El administrador de
 * plataforma (contexto sin clínica) queda fuera por diseño, incluso si algún día recibiera
 * el permiso por error.
 */
export function clinicScope(principal: AuthPrincipal): ClinicScope {
  const ctx = principal.context;
  if (!ctx || ctx.clinicId === null) {
    throw new ForbiddenException('Los datos de pacientes solo son accesibles dentro del contexto de una clínica');
  }
  return { clinicId: ctx.clinicId, branchId: ctx.branchId };
}

/** Un paciente de otra clínica responde 404 igual que uno inexistente (no revela su existencia). */
export async function requirePatient(
  db: DbTx | PrismaDb,
  clinicId: string,
  patientId: string,
  opts: { active?: boolean } = {},
) {
  const patient = await db.patient.findFirst({ where: { id: patientId, clinicId } });
  if (!patient) throw new NotFoundException('Paciente no encontrado');
  if (opts.active && patient.status !== 'ACTIVE') {
    throw new ConflictException('El paciente está inactivo; reactívelo para modificarlo');
  }
  return patient;
}

export const canReadFull = (p: AuthPrincipal): boolean => p.permissions.has('patient:read');

export function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';
}
