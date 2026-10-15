import { Inject, Injectable } from '@nestjs/common';
import type { AuthPrincipal } from '../auth/auth.types.js';
import type { PrismaDb } from '../prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';

const USER_VIEW = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  status: true,
  lastLoginAt: true,
  createdAt: true,
} as const;

@Injectable()
export class UsersService {
  constructor(@Inject(PRISMA) private readonly db: PrismaDb) {}

  /** Plataforma: todos. Clínica: solo usuarios con asignación en su clínica (y sede, si el contexto la fija). */
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
      where: ctx.clinicId === null ? {} : { assignments: { some: { ...inScope, status: 'ACTIVE' } } },
      select: {
        ...USER_VIEW,
        // Solo se muestran las asignaciones dentro del alcance del solicitante.
        assignments: {
          where: inScope,
          select: { id: true, clinicId: true, branchId: true, status: true, role: { select: { code: true } } },
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
      permissions: r.permissions.map((p) => p.permission.code).sort(),
    }));
  }
}
