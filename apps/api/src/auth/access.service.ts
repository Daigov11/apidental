import { Inject, Injectable } from '@nestjs/common';
import { PRISMA } from '../prisma/prisma.module.js';
import type { PrismaDb } from '../prisma/client.js';
import type { ActiveContext } from './auth.types.js';

export interface AvailableContext {
  assignmentId: string;
  role: { code: string; name: string };
  clinic: { id: string; name: string } | null;
  branch: { id: string; name: string } | null;
}

export interface ResolvedAccess {
  roles: string[];
  permissions: Set<string>;
}

/**
 * Resuelve acceso a partir de UserAssignment. Es la ÚNICA fuente de permisos:
 * sin asignación activa (con clínica y sede activas) no hay acceso.
 */
@Injectable()
export class AccessService {
  constructor(@Inject(PRISMA) private readonly db: PrismaDb) {}

  async listContexts(userId: string): Promise<AvailableContext[]> {
    const rows = await this.db.userAssignment.findMany({
      where: this.activeAssignmentFilter(userId),
      include: {
        role: { select: { code: true, name: true } },
        clinic: { select: { id: true, name: true } },
        branch: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({
      assignmentId: r.id,
      role: r.role,
      clinic: r.clinic,
      branch: r.branch,
    }));
  }

  /**
   * Permisos efectivos de un usuario en un contexto. Devuelve null si no tiene
   * ninguna asignación activa que cubra ese contexto.
   *  - clinicId null  => contexto de plataforma (asignaciones sin clínica).
   *  - branchId null  => contexto de toda la clínica (solo asignaciones sin sede).
   *  - branchId dado  => asignaciones de esa sede + asignaciones de toda la clínica.
   */
  async resolve(userId: string, context: ActiveContext): Promise<ResolvedAccess | null> {
    const { clinicId, branchId } = context;
    if (clinicId === null && branchId !== null) return null;

    // La sede pedida debe existir, estar activa y pertenecer a ESA clínica; si no, un
    // contexto {clinicA, sedeDeClinicaB} pasaría gracias a una asignación de toda la clínica.
    if (clinicId !== null && branchId !== null) {
      const branch = await this.db.branch.findFirst({
        where: { id: branchId, clinicId, status: 'ACTIVE' },
        select: { id: true },
      });
      if (!branch) return null;
    }

    // Sede concreta: aplican sus asignaciones y las de toda la clínica (branchId null).
    const all = await this.db.userAssignment.findMany({
      where: {
        AND: [
          this.activeAssignmentFilter(userId),
          { clinicId },
          // Defensa en profundidad: el alcance del rol debe coincidir con el contexto.
          { role: { scope: clinicId === null ? ('PLATFORM' as const) : ('CLINIC' as const) } },
          branchId === null ? { branchId: null } : { OR: [{ branchId }, { branchId: null }] },
        ],
      },
      include: { role: { include: { permissions: { include: { permission: true } } } } },
    });

    if (all.length === 0) return null;

    const roles = new Set<string>();
    const permissions = new Set<string>();
    for (const a of all) {
      roles.add(a.role.code);
      for (const rp of a.role.permissions) permissions.add(rp.permission.code);
    }
    return { roles: [...roles], permissions };
  }

  private activeAssignmentFilter(userId: string) {
    return {
      userId,
      status: 'ACTIVE' as const,
      OR: [
        { clinicId: null },
        {
          clinic: { is: { status: 'ACTIVE' as const } },
          OR: [{ branchId: null }, { branch: { is: { status: 'ACTIVE' as const } } }],
        },
      ],
    };
  }
}
