import { Inject, Injectable } from '@nestjs/common';
import type { AuthPrincipal } from '../auth/auth.types.js';
import type { PrismaDb } from '../prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';
import { RETIRED_ROLE_CODES } from '../auth/permissions.js';

const USER_VIEW = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  status: true,
  lastLoginAt: true,
  disabledAt: true,
  createdAt: true,
} as const;

@Injectable()
export class UsersService {
  constructor(@Inject(PRISMA) private readonly db: PrismaDb) {}

  /**
   * Plataforma: todos. Clínica: usuarios con alguna asignación en su clínica (y sede, si el contexto la fija), incluidas las
   * retiradas, y las cuentas de Apiworking que ya ingresaron pero todavía no tienen rol (para poder asignárselo).
   */
  list(actor: AuthPrincipal, limit: number, offset: number) {
    const ctx = actor.context!;
    const inScope =
      ctx.clinicId === null
        ? {}
        : {
            clinicId: ctx.clinicId,
            ...(ctx.branchId ? { OR: [{ branchId: null }, { branchId: ctx.branchId }] } : {}),
          };
    return this.db.user.findMany({
      where: ctx.clinicId === null ? {} : { OR: [{ assignments: { some: inScope } }, { assignments: { none: {} }, externalIdentity: { isNot: null } }] },
      select: {
        ...USER_VIEW,
        externalIdentity: { select: { externalUsername: true } },
        // Solo se muestran las asignaciones dentro del alcance del solicitante.
        assignments: {
          where: inScope,
          select: { id: true, clinicId: true, branchId: true, status: true, role: { select: { code: true, name: true } } },
        },
      },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      take: limit,
      skip: offset,
    });
  }

  async listRoles(actor: AuthPrincipal) {
    const platform = actor.context!.clinicId === null;
    const roles = await this.db.role.findMany({
      where: platform ? {} : { scope: 'CLINIC' },
      include: { permissions: { include: { permission: { select: { code: true } } } } },
      orderBy: { name: 'asc' },
    });
    return roles.map((r) => ({
      code: r.code,
      name: r.name,
      scope: r.scope,
      description: r.description,
      /** Rol retirado: no se asigna ni se ofrece en el panel. */
      retired: RETIRED_ROLE_CODES.includes(r.code),
      permissions: r.permissions.map((p) => p.permission.code).sort(),
    }));
  }
}
