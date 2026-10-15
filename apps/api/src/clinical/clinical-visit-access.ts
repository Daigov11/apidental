import type { AuthPrincipal } from '../auth/auth.types.js';
import type { DbTx } from '../prisma/client.js';
import type {
  ClinicalAccessDecision,
  ClinicalAccessService,
} from './clinical-access.service.js';
import { recordNotFound } from './clinical-versioning.js';
import type { RequestMeta } from '../common/utils/request-meta.js';

export interface VisitLock {
  id: string;
  status: string;
  branchId: string;
  dentistUserId: string;
  version: number;
}

/** Se lanza dentro de una transacción y se convierte, FUERA de ella, en una negativa auditada (la transacción se revierte). */
export class VisitAccessError extends Error {
  constructor(
    readonly reason: string,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type Row = {
  id: string;
  status: string;
  branch_id: string;
  dentist_user_id: string;
  version: number;
};
const toLock = (r: Row): VisitLock => ({
  id: r.id,
  status: r.status,
  branchId: r.branch_id,
  dentistUserId: r.dentist_user_id,
  version: r.version,
});

/** Bloqueo compartido: varios elementos se registran a la vez, pero ninguno mientras la visita se cierra. */
export async function lockVisitShared(
  tx: DbTx,
  visitId: string,
  clinicId: string,
  patientId: string,
): Promise<VisitLock> {
  const rows = await tx.$queryRaw<Row[]>`
    SELECT id, status, branch_id, dentist_user_id, version FROM clinical_visits
    WHERE id = ${visitId} AND clinic_id = ${clinicId} AND patient_id = ${patientId} FOR SHARE`;
  if (!rows[0]) throw recordNotFound();
  return toLock(rows[0]);
}

export async function lockVisitExclusive(
  tx: DbTx,
  visitId: string,
  clinicId: string,
  patientId: string,
): Promise<VisitLock> {
  const rows = await tx.$queryRaw<Row[]>`
    SELECT id, status, branch_id, dentist_user_id, version FROM clinical_visits
    WHERE id = ${visitId} AND clinic_id = ${clinicId} AND patient_id = ${patientId} FOR UPDATE`;
  if (!rows[0]) throw recordNotFound();
  return toLock(rows[0]);
}

/** Solo el odontólogo responsable de la visita, en la sede de la visita, registra o modifica sus elementos. */
export function assertVisitWriter(
  visit: Pick<VisitLock, 'dentistUserId' | 'branchId'>,
  actor: AuthPrincipal,
  d: ClinicalAccessDecision,
): void {
  if (visit.dentistUserId !== actor.user.id) {
    throw new VisitAccessError(
      'not_visit_responsible',
      'NOT_VISIT_RESPONSIBLE',
      'Solo el odontólogo responsable de la visita puede registrar o modificar sus elementos',
    );
  }
  if (d.branchId !== visit.branchId) {
    throw new VisitAccessError(
      'wrong_branch',
      'WRONG_BRANCH',
      'La visita corresponde a otra sede; seleccione esa sede para modificarla',
    );
  }
}

/** Ejecuta `fn`; si lanza VisitAccessError, audita la negativa (CLINICAL_ACCESS_DENIED) y responde 403. */
export async function withVisitDenial<T>(
  access: ClinicalAccessService,
  actor: AuthPrincipal,
  patientId: string,
  meta: RequestMeta,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof VisitAccessError) {
      await access.denyBy(actor, patientId, meta, {
        reason: error.reason,
        code: error.code,
        message: error.message,
      });
    }
    throw error;
  }
}
