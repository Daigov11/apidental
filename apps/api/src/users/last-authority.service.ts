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
 * Debe invocarse DENTRO de la transacción de la operación que quita autoridad (revocar una asignación o
 * deshabilitar un usuario). Hace una lectura con bloqueo (FOR UPDATE) de las
 * asignaciones restantes: dos revocaciones simultáneas se serializan y la segunda ve el resultado de
 * la primera, así que no pueden dejar la clínica vacía "a la vez".
 *
 * Cuentan solo las autoridades realmente operativas: asignación activa, usuario activo y clínica activa.
 */
@Injectable()
export class LastAuthorityService {
  /** ¿Es una autoridad protegida? (administrador de TODA la clínica, Director o administrador de plataforma) */
  isProtected(a: Pick<RemovableAssignment, 'roleCode' | 'clinicId' | 'branchId'>): boolean {
    return (
      (a.roleCode === 'PLATFORM_ADMIN' && a.clinicId === null) ||
      (a.roleCode === 'CLINIC_ADMIN' && a.branchId === null && a.clinicId !== null) ||
      (a.roleCode === 'CLINICAL_DIRECTOR' && a.clinicId !== null)
    );
  }

  /**
   * Serializa por clínica (o por la plataforma): se bloquea PRIMERO esa fila, de modo que dos operaciones
   * concurrentes sobre la misma clínica hagan fila y la segunda lea lo que la primera confirmó. Bloquear solo
   * las filas "restantes" NO basta: dos operaciones pueden pasar a la vez cada una viendo a la otra intacta.
   */
  private async lock(tx: DbTx, a: Pick<RemovableAssignment, 'roleCode' | 'clinicId'>): Promise<void> {
    if (a.clinicId === null) await tx.$queryRaw`SELECT id FROM roles WHERE code = 'PLATFORM_ADMIN' FOR UPDATE`;
    else await tx.$queryRaw`SELECT id FROM clinics WHERE id = ${a.clinicId} FOR UPDATE`;
  }

  async assertCanRemove(tx: DbTx, a: RemovableAssignment): Promise<void> {
    if (!this.isProtected(a)) return; // rol sin protección de "último"
    await this.lock(tx, a);

    let remaining: { id: string }[];
    if (a.roleCode === 'PLATFORM_ADMIN') {
      remaining = await tx.$queryRaw<{ id: string }[]>`
        SELECT ua.id FROM user_assignments ua
        JOIN roles r ON r.id = ua.role_id
        JOIN users u ON u.id = ua.user_id
        WHERE r.code = 'PLATFORM_ADMIN' AND ua.status = 'ACTIVE' AND ua.clinic_id IS NULL
          AND ua.id <> ${a.id} AND u.status = 'ACTIVE'
        FOR UPDATE`;
    } else if (a.roleCode === 'CLINIC_ADMIN') {
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
    } else {
      remaining = await tx.$queryRaw<{ id: string }[]>`
        SELECT ua.id FROM user_assignments ua
        JOIN roles r ON r.id = ua.role_id
        JOIN users u ON u.id = ua.user_id
        JOIN clinics c ON c.id = ua.clinic_id
        WHERE r.code = 'CLINICAL_DIRECTOR' AND ua.status = 'ACTIVE'
          AND ua.clinic_id = ${a.clinicId} AND ua.id <> ${a.id}
          AND u.status = 'ACTIVE' AND c.status = 'ACTIVE'
        FOR UPDATE`;
    }
    if (remaining.length === 0) throw new LastAuthorityError(MESSAGES[a.roleCode]!);
  }

  /**
   * Antes de DESHABILITAR a un usuario: cada autoridad protegida que ejerce debe tener relevo operativo.
   * Se evalúan en un orden estable (por clínica) para que dos deshabilitaciones concurrentes sobre varias
   * clínicas no se bloqueen entre sí en orden inverso. Devuelve las autoridades que ejercía.
   */
  async assertCanDisableUser(tx: DbTx, userId: string): Promise<RemovableAssignment[]> {
    const rows = await tx.userAssignment.findMany({
      where: { userId, status: 'ACTIVE' },
      select: { id: true, clinicId: true, branchId: true, role: { select: { code: true } } },
    });
    const protectedOnes = rows
      .map((r) => ({ id: r.id, roleCode: r.role.code, clinicId: r.clinicId, branchId: r.branchId }))
      .filter((a) => this.isProtected(a))
      .sort((x, y) => (x.clinicId ?? '').localeCompare(y.clinicId ?? '') || x.roleCode.localeCompare(y.roleCode));
    for (const a of protectedOnes) await this.assertCanRemove(tx, a);
    return protectedOnes;
  }
}
