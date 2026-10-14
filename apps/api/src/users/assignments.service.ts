import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, AuditService } from '../audit/audit.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import type { RequestMeta } from '../common/utils/request-meta.js';
import type { DbTx, PrismaDb } from '../prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';
import { assignmentKey } from './assignment-key.js';
import type { GrantDto } from './dto/users.dto.js';

export interface ValidatedGrant {
  roleId: string;
  roleCode: string;
  clinicId: string | null;
  branchId: string | null;
}

const ASSIGNMENT_VIEW = {
  id: true,
  userId: true,
  clinicId: true,
  branchId: true,
  status: true,
  createdAt: true,
  role: { select: { code: true, name: true } },
} as const;

/**
 * Reglas de asignación (el modelo de datos permite combinaciones que el negocio no):
 *  1. Rol PLATFORM => sin clínica ni sede, y solo lo otorga un administrador de plataforma.
 *  2. Rol CLINIC   => clínica obligatoria; sede opcional (sin sede = toda la clínica).
 *  3. Una clínica solo asigna dentro de su clínica; si su contexto está fijado a una sede,
 *     solo dentro de esa sede.
 *  4. Anti-escalada: nadie otorga un rol con permisos que no posee en su contexto.
 *  5. La sede debe pertenecer a la clínica y ambas deben estar activas.
 */
@Injectable()
export class AssignmentsService {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaDb,
    private readonly audit: AuditService,
  ) {}

  async validateGrant(actor: AuthPrincipal, grant: GrantDto, db: DbTx | PrismaDb = this.db): Promise<ValidatedGrant> {
    const ctx = actor.context!;
    const actorIsPlatform = ctx.clinicId === null;

    const role = await db.role.findUnique({
      where: { code: grant.roleCode },
      include: { permissions: { include: { permission: { select: { code: true } } } } },
    });
    if (!role) throw new BadRequestException('Rol desconocido');

    if (!role.permissions.every((rp) => actor.permissions.has(rp.permission.code))) {
      throw new ForbiddenException('No puede otorgar un rol con más permisos que los suyos');
    }

    if (role.scope === 'PLATFORM') {
      if (!actorIsPlatform) throw new ForbiddenException('Solo la plataforma puede otorgar roles de plataforma');
      if (grant.clinicId || grant.branchId) {
        throw new BadRequestException('Los roles de plataforma no llevan clínica ni sede');
      }
      return { roleId: role.id, roleCode: role.code, clinicId: null, branchId: null };
    }

    if (!actorIsPlatform && grant.clinicId && grant.clinicId !== ctx.clinicId) {
      throw new ForbiddenException('No puede asignar roles en otra clínica');
    }
    const clinicId = actorIsPlatform ? grant.clinicId : ctx.clinicId;
    if (!clinicId) throw new BadRequestException('clinicId es obligatorio para roles de clínica');

    if (!actorIsPlatform && ctx.branchId && grant.branchId && grant.branchId !== ctx.branchId) {
      throw new ForbiddenException('Su contexto está limitado a una sede');
    }
    const branchId = grant.branchId ?? (actorIsPlatform ? null : ctx.branchId);

    const clinic = await db.clinic.findUnique({ where: { id: clinicId }, select: { status: true } });
    if (!clinic || clinic.status !== 'ACTIVE') throw new BadRequestException('Clínica no encontrada o inactiva');
    if (branchId) {
      const branch = await db.branch.findFirst({
        where: { id: branchId, clinicId },
        select: { status: true },
      });
      if (!branch || branch.status !== 'ACTIVE') {
        throw new BadRequestException('La sede no existe en esa clínica o está inactiva');
      }
    }
    return { roleId: role.id, roleCode: role.code, clinicId, branchId };
  }

  /** Crea (o reactiva) la asignación ya validada. Debe invocarse dentro de la transacción del llamador. */
  async persist(actor: AuthPrincipal, userId: string, grant: ValidatedGrant, meta: RequestMeta, tx: DbTx) {
    const key = assignmentKey(userId, grant);
    const existing = await tx.userAssignment.findUnique({ where: { assignmentKey: key } });
    if (existing?.status === 'ACTIVE') throw new ConflictException('La asignación ya existe');

    const summary = { roleCode: grant.roleCode, targetUserId: userId };
    const auditBase = {
      entity: 'UserAssignment',
      userId: actor.user.id,
      clinicId: grant.clinicId,
      branchId: grant.branchId,
      meta,
      summary,
    };
    if (existing) {
      const row = await tx.userAssignment.update({
        where: { id: existing.id },
        data: { status: 'ACTIVE' },
        select: ASSIGNMENT_VIEW,
      });
      await this.audit.record({ ...auditBase, action: AuditAction.AssignmentReactivated, entityId: row.id }, tx);
      return row;
    }
    const row = await tx.userAssignment.create({
      data: {
        userId,
        roleId: grant.roleId,
        clinicId: grant.clinicId,
        branchId: grant.branchId,
        assignmentKey: key,
      },
      select: ASSIGNMENT_VIEW,
    });
    await this.audit.record({ ...auditBase, action: AuditAction.AssignmentCreated, entityId: row.id }, tx);
    return row;
  }

  async create(actor: AuthPrincipal, userId: string, grant: GrantDto, meta: RequestMeta) {
    const validated = await this.validateGrant(actor, grant);
    const user = await this.db.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) throw new NotFoundException('Usuario no encontrado');
    return this.db.$transaction((tx) => this.persist(actor, userId, validated, meta, tx));
  }

  async revoke(actor: AuthPrincipal, assignmentId: string, meta: RequestMeta) {
    const ctx = actor.context!;
    const target = await this.db.userAssignment.findUnique({
      where: { id: assignmentId },
      select: { id: true, userId: true, clinicId: true, branchId: true, status: true, role: { select: { code: true } } },
    });
    // Un 404 uniforme evita revelar asignaciones de otras clínicas.
    if (!target) throw new NotFoundException('Asignación no encontrada');
    const actorIsPlatform = ctx.clinicId === null;
    if (!actorIsPlatform) {
      if (target.clinicId !== ctx.clinicId) throw new NotFoundException('Asignación no encontrada');
      if (ctx.branchId && target.branchId !== ctx.branchId) {
        throw new NotFoundException('Asignación no encontrada');
      }
    }
    if (target.userId === actor.user.id) {
      throw new ForbiddenException('No puede revocar sus propias asignaciones');
    }
    if (target.status === 'INACTIVE') return this.view(assignmentId);

    return this.db.$transaction(async (tx) => {
      const row = await tx.userAssignment.update({
        where: { id: assignmentId },
        data: { status: 'INACTIVE' },
        select: ASSIGNMENT_VIEW,
      });
      await this.audit.record(
        {
          action: AuditAction.AssignmentRevoked,
          entity: 'UserAssignment',
          entityId: assignmentId,
          userId: actor.user.id,
          clinicId: target.clinicId,
          branchId: target.branchId,
          meta,
          summary: { roleCode: target.role.code, targetUserId: target.userId },
        },
        tx,
      );
      return row;
    });
  }

  private view(id: string) {
    return this.db.userAssignment.findUniqueOrThrow({ where: { id }, select: ASSIGNMENT_VIEW });
  }
}
