import { withTxRetry } from '../common/utils/tx-retry.js';
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
import { CARE_ATTENDANCE_PERMISSIONS } from '../auth/permissions.js';
import { endCareRelationshipsOf } from '../clinical/care-ending.js';
import { assignmentKey } from './assignment-key.js';
import {
  LastAuthorityError,
  LastAuthorityService,
} from './last-authority.service.js';
import type { GrantDto } from './dto/users.dto.js';

export interface GrantOptions {
  /** Solo el flujo de invitación formal del Director Clínico. */
  allowDirector?: boolean;
  /** Solo el flujo de invitación: la plataforma invita al primer administrador de una clínica. */
  platformMayInviteClinicAdmin?: boolean;
}

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
 *     La plataforma NO otorga roles de clínica (solo invita al primer administrador) y el
 *     Director Clínico solo se designa por invitación formal (ver validateGrant).
 *  5. La sede debe pertenecer a la clínica y ambas deben estar activas.
 */
@Injectable()
export class AssignmentsService {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaDb,
    private readonly audit: AuditService,
    private readonly lastAuthority: LastAuthorityService,
  ) {}

  async validateGrant(
    actor: AuthPrincipal,
    grant: GrantDto,
    db: DbTx | PrismaDb = this.db,
    opts: GrantOptions = {},
  ): Promise<ValidatedGrant> {
    const ctx = actor.context!;
    const actorIsPlatform = ctx.clinicId === null;

    const role = await db.role.findUnique({
      where: { code: grant.roleCode },
      include: {
        permissions: { include: { permission: { select: { code: true } } } },
      },
    });
    if (!role) throw new BadRequestException('Rol desconocido');

    // El Director Clínico tiene autoridad clínica: solo se designa por invitación formal
    // (registro de aprovisionamiento + reautenticación), nunca por una asignación directa.
    if (role.code === 'CLINICAL_DIRECTOR' && !opts.allowDirector) {
      throw new ForbiddenException(
        'El rol Director Clínico solo se otorga mediante invitación formal con registro de aprovisionamiento',
      );
    }

    // La plataforma ya NO otorga roles de clínica (se retiró la excepción del incremento 2). Su única vía es
    // invitar al PRIMER administrador de una clínica sin administrador, que define su propia contraseña.
    const platformInvitesClinicAdmin =
      Boolean(opts.platformMayInviteClinicAdmin) &&
      actorIsPlatform &&
      role.code === 'CLINIC_ADMIN';
    if (
      actorIsPlatform &&
      role.scope === 'CLINIC' &&
      !platformInvitesClinicAdmin
    ) {
      throw new ForbiddenException(
        'La plataforma no otorga roles de clínica; solo invita al primer administrador de la clínica',
      );
    }

    // Anti-escalada: no se otorga un rol con permisos que el otorgante no posee. Excepciones explícitas y
    // acotadas: la invitación del primer administrador por la plataforma y la del Director Clínico (que
    // tiene sus propias exigencias formales).
    // Excepción acotada: los permisos de atención (clinical:read/write/read_limited) no confieren acceso por sí
    // solos (exigen relación asistencial, que asigna OTRA persona), así que un administrador puede incorporar
    // odontólogos y asistentes sin poseerlos. clinical:read_all y el resto siguen sujetos a la regla.
    const attendance = CARE_ATTENDANCE_PERMISSIONS as readonly string[];
    if (
      !platformInvitesClinicAdmin &&
      !opts.allowDirector &&
      !role.permissions.every(
        (rp) =>
          actor.permissions.has(rp.permission.code) ||
          attendance.includes(rp.permission.code),
      )
    ) {
      throw new ForbiddenException(
        'No puede otorgar un rol con más permisos que los suyos',
      );
    }

    if (role.scope === 'PLATFORM') {
      if (!actorIsPlatform)
        throw new ForbiddenException(
          'Solo la plataforma puede otorgar roles de plataforma',
        );
      if (grant.clinicId || grant.branchId) {
        throw new BadRequestException(
          'Los roles de plataforma no llevan clínica ni sede',
        );
      }
      return {
        roleId: role.id,
        roleCode: role.code,
        clinicId: null,
        branchId: null,
      };
    }

    if (!actorIsPlatform && grant.clinicId && grant.clinicId !== ctx.clinicId) {
      throw new ForbiddenException('No puede asignar roles en otra clínica');
    }
    const clinicId = actorIsPlatform ? grant.clinicId : ctx.clinicId;
    if (!clinicId)
      throw new BadRequestException(
        'clinicId es obligatorio para roles de clínica',
      );

    if (
      !actorIsPlatform &&
      ctx.branchId &&
      grant.branchId &&
      grant.branchId !== ctx.branchId
    ) {
      throw new ForbiddenException('Su contexto está limitado a una sede');
    }
    const branchId = grant.branchId ?? (actorIsPlatform ? null : ctx.branchId);

    const clinic = await db.clinic.findUnique({
      where: { id: clinicId },
      select: { status: true },
    });
    if (!clinic || clinic.status !== 'ACTIVE')
      throw new BadRequestException('Clínica no encontrada o inactiva');
    if (branchId) {
      const branch = await db.branch.findFirst({
        where: { id: branchId, clinicId },
        select: { status: true },
      });
      if (!branch || branch.status !== 'ACTIVE') {
        throw new BadRequestException(
          'La sede no existe en esa clínica o está inactiva',
        );
      }
    }
    return { roleId: role.id, roleCode: role.code, clinicId, branchId };
  }

  /** Crea (o reactiva) la asignación ya validada. Debe invocarse dentro de la transacción del llamador. */
  async persist(
    actorId: string,
    userId: string,
    grant: ValidatedGrant,
    meta: RequestMeta,
    tx: DbTx,
    /** Quien OTORGA el rol (en una invitación, quien invitó). Alimenta la separación de funciones. */
    grantedById: string = actorId,
  ) {
    const key = assignmentKey(userId, grant);
    const existing = await tx.userAssignment.findUnique({
      where: { assignmentKey: key },
    });
    if (existing?.status === 'ACTIVE')
      throw new ConflictException('La asignación ya existe');

    const summary = { roleCode: grant.roleCode, targetUserId: userId };
    const auditBase = {
      entity: 'UserAssignment',
      userId: actorId,
      clinicId: grant.clinicId,
      branchId: grant.branchId,
      meta,
      summary,
    };
    if (existing) {
      const row = await tx.userAssignment.update({
        where: { id: existing.id },
        data: { status: 'ACTIVE', grantedById },
        select: ASSIGNMENT_VIEW,
      });
      await this.audit.record(
        {
          ...auditBase,
          action: AuditAction.AssignmentReactivated,
          entityId: row.id,
        },
        tx,
      );
      await this.auditClinicalRole(
        grant,
        row.id,
        userId,
        grantedById,
        actorId,
        meta,
        tx,
      );
      return row;
    }
    const row = await tx.userAssignment.create({
      data: {
        userId,
        roleId: grant.roleId,
        clinicId: grant.clinicId,
        branchId: grant.branchId,
        assignmentKey: key,
        grantedById,
      },
      select: ASSIGNMENT_VIEW,
    });
    await this.audit.record(
      { ...auditBase, action: AuditAction.AssignmentCreated, entityId: row.id },
      tx,
    );
    await this.auditClinicalRole(
      grant,
      row.id,
      userId,
      grantedById,
      actorId,
      meta,
      tx,
    );
    return row;
  }

  /** Otorgar un rol de atención clínica deja un rastro propio (quién lo otorgó y a quién) para revisión del Director. */
  private async auditClinicalRole(
    grant: ValidatedGrant,
    assignmentId: string,
    userId: string,
    grantedById: string,
    actorId: string,
    meta: RequestMeta,
    tx: DbTx,
  ) {
    if (grant.roleCode !== 'DENTIST' && grant.roleCode !== 'ASSISTANT') return;
    await this.audit.record(
      {
        action: AuditAction.ClinicalRoleGranted,
        entity: 'UserAssignment',
        entityId: assignmentId,
        userId: actorId,
        clinicId: grant.clinicId,
        branchId: grant.branchId,
        meta,
        summary: {
          roleCode: grant.roleCode,
          targetUserId: userId,
          grantedById,
        },
      },
      tx,
    );
  }

  async create(
    actor: AuthPrincipal,
    userId: string,
    grant: GrantDto,
    meta: RequestMeta,
  ) {
    // Separación de funciones: nadie se otorga roles a sí mismo (ni un administrador se hace odontólogo).
    if (userId === actor.user.id) {
      await this.audit.recordSafely({
        action: AuditAction.EscalationBlocked,
        entity: 'UserAssignment',
        userId: actor.user.id,
        clinicId: actor.context?.clinicId ?? null,
        branchId: actor.context?.branchId ?? null,
        meta,
        summary: { reason: 'self_grant', roleCode: grant.roleCode },
      });
      throw new ForbiddenException(
        'No puede otorgarse roles a sí mismo; debe hacerlo otra persona autorizada',
      );
    }
    const validated = await this.validateGrant(actor, grant);
    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!user) throw new NotFoundException('Usuario no encontrado');
    return this.db.$transaction((tx) =>
      this.persist(actor.user.id, userId, validated, meta, tx),
    );
  }

  async revoke(actor: AuthPrincipal, assignmentId: string, meta: RequestMeta) {
    const ctx = actor.context!;
    const target = await this.db.userAssignment.findUnique({
      where: { id: assignmentId },
      select: {
        id: true,
        userId: true,
        clinicId: true,
        branchId: true,
        status: true,
        role: { select: { code: true } },
      },
    });
    // Un 404 uniforme evita revelar asignaciones de otras clínicas.
    if (!target) throw new NotFoundException('Asignación no encontrada');
    const actorIsPlatform = ctx.clinicId === null;
    if (!actorIsPlatform) {
      if (target.clinicId !== ctx.clinicId)
        throw new NotFoundException('Asignación no encontrada');
      if (ctx.branchId && target.branchId !== ctx.branchId) {
        throw new NotFoundException('Asignación no encontrada');
      }
    }
    if (target.userId === actor.user.id) {
      throw new ForbiddenException('No puede revocar sus propias asignaciones');
    }
    if (target.status === 'INACTIVE') return this.view(assignmentId);

    // Protección del Director Clínico: solo OTRO Director vigente de la clínica puede retirarle el rol. Quien tiene
    // solo `assignment:manage` (administración) o ninguno (plataforma) no. Las demás asignaciones exigen `assignment:manage`.
    const isDirector = target.role.code === 'CLINICAL_DIRECTOR';
    if (
      isDirector
        ? !actor.permissions.has('director:manage')
        : !actor.permissions.has('assignment:manage')
    ) {
      if (isDirector)
        await this.directorBlocked(
          actor,
          target.clinicId,
          'revoke_director_role',
          meta,
        );
      throw new ForbiddenException(
        isDirector
          ? 'Solo otro Director Clínico vigente de la clínica puede retirar el rol de Director Clínico'
          : 'No tiene permisos para esta operación',
      );
    }

    try {
      return await withTxRetry(() =>
        this.db.$transaction(
          async (tx) => {
            // Una clínica nunca puede quedar sin autoridad administrativa ni (si ya hay) clínica.
            await this.lastAuthority.assertCanRemove(tx, {
              id: assignmentId,
              roleCode: target.role.code,
              clinicId: target.clinicId,
              branchId: target.branchId,
            });
            return this.applyRevoke(tx, actor, target, assignmentId, meta);
          },
          { isolationLevel: 'ReadCommitted' },
        ),
      );
    } catch (error) {
      if (error instanceof LastAuthorityError) {
        await this.audit.recordSafely({
          action: AuditAction.LastAuthorityBlocked,
          entity: 'UserAssignment',
          entityId: assignmentId,
          userId: actor.user.id,
          clinicId: target.clinicId,
          branchId: target.branchId,
          meta,
          summary: { roleCode: target.role.code, blockedOperation: 'revoke' },
        });
        throw new ConflictException({
          message: error.message,
          code: 'LAST_AUTHORITY',
          roleCode: target.role.code,
        });
      }
      throw error;
    }
  }

  private directorBlocked(
    actor: AuthPrincipal,
    clinicId: string | null,
    operation: string,
    meta: RequestMeta,
  ) {
    return this.audit.recordSafely({
      action: AuditAction.DirectorProtectionBlocked,
      entity: 'UserAssignment',
      userId: actor.user.id,
      clinicId,
      meta,
      summary: { operation, actorRoles: actor.roles },
    });
  }

  private async applyRevoke(
    tx: DbTx,
    actor: AuthPrincipal,
    target: {
      userId: string;
      clinicId: string | null;
      branchId: string | null;
      role: { code: string };
    },
    assignmentId: string,
    meta: RequestMeta,
  ) {
    // El bloqueo de la fila del usuario va ANTES de retirar el rol: la creación de relaciones asistenciales lo toma
    // igual, así que no puede nacer una relación para un odontólogo que está perdiendo su rol.
    if (target.role.code === 'DENTIST')
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${target.userId} FOR UPDATE`;
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
    // Sin ningún rol de odontólogo vigente en la clínica, terminan sus relaciones asistenciales de esa clínica.
    if (target.role.code === 'DENTIST' && target.clinicId) {
      const remaining = await tx.userAssignment.count({
        where: {
          userId: target.userId,
          clinicId: target.clinicId,
          status: 'ACTIVE',
          role: { code: 'DENTIST' },
        },
      });
      if (remaining === 0) {
        await endCareRelationshipsOf(tx, this.audit, {
          dentistUserId: target.userId,
          clinicId: target.clinicId,
          actorId: actor.user.id,
          endKind: 'SYSTEM',
          reason: 'Se retiró el rol de odontólogo',
          meta,
        });
      }
    }
    return row;
  }

  private view(id: string) {
    return this.db.userAssignment.findUniqueOrThrow({
      where: { id },
      select: ASSIGNMENT_VIEW,
    });
  }
}
