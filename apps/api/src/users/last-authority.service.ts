import { Injectable } from '@nestjs/common';
import type { DbTx } from '../prisma/client.js';

export class LastAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LastAuthorityError';
  }
}

export interface RemovableAssignment {
  id: string;
  roleCode: string;
  clinicId: string | null;
  branchId: string | null;
}

const MESSAGES: Record<string, string> = {
  PLATFORM_ADMIN: 'No puede quitar al último administrador de plataforma',
  CLINIC_ADMIN: 'No puede quitar al último administrador de la clínica: la clínica quedaría sin autoridad administrativa',
  CLINICAL_DIRECTOR: 'No puede quitar al último Director Clínico: la clínica quedaría sin autoridad clínica',
};

/**
 * Regla de "último administrador": una clínica nunca puede quedar sin autoridad administrativa
 * (CLINIC_ADMIN de toda la clínica) ni, una vez designado, sin autoridad clínica (CLINICAL_DIRECTOR);
 * la plataforma tampoco puede quedar sin PLATFORM_ADMIN.
 *
 * Debe invocarse DENTRO de la transacción de la operación que quita autoridad (revocar una asignación;
 * y, cuando exista, deshabilitar un usuario). Hace una lectura con bloqueo (FOR UPDATE) de las
 * asignaciones restantes: dos revocaciones simultáneas se serializan y la segunda ve el resultado de
 * la primera, así que no pueden dejar la clínica vacía "a la vez".
 *
 * Cuentan solo las autoridades realmente operativas: asignación activa, usuario activo y clínica activa.
 */
@Injectable()
export class LastAuthorityService {
  async assertCanRemove(tx: DbTx, a: RemovableAssignment): Promise<void> {
    let remaining: { id: string }[];
    if (a.roleCode === 'PLATFORM_ADMIN' && a.clinicId === null) {
      remaining = await tx.$queryRaw<{ id: string }[]>`
        SELECT ua.id FROM user_assignments ua
        JOIN roles r ON r.id = ua.role_id
        JOIN users u ON u.id = ua.user_id
        WHERE r.code = 'PLATFORM_ADMIN' AND ua.status = 'ACTIVE' AND ua.clinic_id IS NULL
          AND ua.id <> ${a.id} AND u.status = 'ACTIVE'
        FOR UPDATE`;
    } else if (a.roleCode === 'CLINIC_ADMIN' && a.branchId === null && a.clinicId) {
      // Solo el administrador de TODA la clínica cuenta como autoridad administrativa.
      remaining = await tx.$queryRaw<{ id: string }[]>`
        SELECT ua.id FROM user_assignments ua
        JOIN roles r ON r.id = ua.role_id
        JOIN users u ON u.id = ua.user_id
        JOIN clinics c ON c.id = ua.clinic_id
        WHERE r.code = 'CLINIC_ADMIN' AND ua.status = 'ACTIVE' AND ua.branch_id IS NULL
          AND ua.clinic_id = ${a.clinicId} AND ua.id <> ${a.id}
          AND u.status = 'ACTIVE' AND c.status = 'ACTIVE'
        FOR UPDATE`;
    } else if (a.roleCode === 'CLINICAL_DIRECTOR' && a.clinicId) {
      remaining = await tx.$queryRaw<{ id: string }[]>`
        SELECT ua.id FROM user_assignments ua
        JOIN roles r ON r.id = ua.role_id
        JOIN users u ON u.id = ua.user_id
        JOIN clinics c ON c.id = ua.clinic_id
        WHERE r.code = 'CLINICAL_DIRECTOR' AND ua.status = 'ACTIVE'
          AND ua.clinic_id = ${a.clinicId} AND ua.id <> ${a.id}
          AND u.status = 'ACTIVE' AND c.status = 'ACTIVE'
        FOR UPDATE`;
    } else {
      return; // rol sin protección de "último"
    }
    if (remaining.length === 0) throw new LastAuthorityError(MESSAGES[a.roleCode]!);
  }
}
