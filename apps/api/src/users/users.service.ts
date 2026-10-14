import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { AuditAction, AuditService } from '../audit/audit.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { hashPassword } from '../common/utils/password.js';
import type { RequestMeta } from '../common/utils/request-meta.js';
import type { PrismaDb } from '../prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';
import { AssignmentsService } from './assignments.service.js';
import type { CreateUserDto } from './dto/users.dto.js';

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
  constructor(
    @Inject(PRISMA) private readonly db: PrismaDb,
    private readonly audit: AuditService,
    private readonly assignments: AssignmentsService,
  ) {}

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

  async create(actor: AuthPrincipal, dto: CreateUserDto, meta: RequestMeta) {
    const ctx = actor.context!;
    if (ctx.clinicId !== null && !dto.assignment) {
      throw new BadRequestException('assignment es obligatorio: el usuario debe quedar asignado a su clínica');
    }
    // Se valida antes de gastar CPU en el hash.
    const grant = dto.assignment ? await this.assignments.validateGrant(actor, dto.assignment) : null;

    if (await this.db.user.findUnique({ where: { email: dto.email }, select: { id: true } })) {
      throw new ConflictException('Ya existe un usuario con ese correo');
    }
    const passwordHash = await hashPassword(dto.password);

    try {
      return await this.db.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: { email: dto.email, passwordHash, firstName: dto.firstName, lastName: dto.lastName },
          select: USER_VIEW,
        });
        await this.audit.record(
          {
            action: AuditAction.UserCreated,
            entity: 'User',
            entityId: user.id,
            userId: actor.user.id,
            clinicId: grant?.clinicId ?? ctx.clinicId,
            branchId: grant?.branchId ?? null,
            meta,
            summary: { email: user.email, roleCode: grant?.roleCode ?? null },
          },
          tx,
        );
        const assignment = grant ? await this.assignments.persist(actor, user.id, grant, meta, tx) : null;
        return { ...user, assignment };
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') {
        throw new ConflictException('Ya existe un usuario con ese correo');
      }
      throw error;
    }
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
