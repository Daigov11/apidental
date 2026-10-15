import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, AuditService } from '../audit/audit.service.js';
import { endCareRelationshipsOf } from '../clinical/care-ending.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { SessionService } from '../auth/session.service.js';
import { withTxRetry } from '../common/utils/tx-retry.js';
import type { RequestMeta } from '../common/utils/request-meta.js';
import type { PrismaDb } from '../prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';
import {
  LastAuthorityError,
  LastAuthorityService,
} from './last-authority.service.js';

/**
 * Deshabilitar y reactivar cuentas. NUNCA se elimina al usuario ni se tocan sus asignaciones ni su
 * auditoría. Deshabilitar es inmediato: revoca sesiones y refresh tokens, invalida las pruebas de
 * reautenticación y las recuperaciones pendientes, y el guard y el login ya rechazan al usuario.
 * Antes se aplica la regla de último administrador/Director; dos operaciones concurrentes sobre una misma
 * clínica se serializan y no pueden dejarla sin autoridad.
 */
@Injectable()
export class UserStatusService {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaDb,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
    private readonly lastAuthority: LastAuthorityService,
  ) {}

  async disable(
    actor: AuthPrincipal,
    targetId: string,
    reason: string,
    meta: RequestMeta,
  ) {
    const ctx = actor.context!;
    const byPlatform = ctx.clinicId === null;
    if (targetId === actor.user.id)
      throw new ForbiddenException('No puede deshabilitar su propia cuenta');

    try {
      return await withTxRetry(() =>
        this.db.$transaction(
          async (tx) => {
            // 1) Alcance (el primer acceso es una lectura SIN snapshot relevante: la transacción es READ COMMITTED).
            const target = await tx.user.findUnique({
              where: { id: targetId },
              select: { id: true, status: true },
            });
            if (!target) throw new NotFoundException('Usuario no encontrado');
            // Protección del Director Clínico: solo OTRO Director vigente de su clínica puede deshabilitarlo.
            const asDirector = await this.assertDirectorProtection(
              tx,
              actor,
              targetId,
            );
            await this.assertInScope(tx, actor, targetId, {
              forDisable: true,
              asDirector,
            });
            if (target.status === 'DISABLED')
              throw new ConflictException('La cuenta ya está deshabilitada');

            // 2) Regla de último administrador / Director (con bloqueo por clínica).
            const authorities = await this.lastAuthority.assertCanDisableUser(
              tx,
              targetId,
            );

            // 3) Efectos, todos en la misma transacción.
            const now = new Date();
            await tx.user.update({
              where: { id: targetId },
              data: {
                status: 'DISABLED',
                disabledAt: now,
                disabledById: actor.user.id,
                disabledReason: reason,
                disabledByPlatform: byPlatform,
              },
            });
            const sessionsRevoked = await this.sessions.revokeAllForUser(
              targetId,
              'USER_DISABLED',
              tx,
            );
            const proofsInvalidated =
              await this.sessions.invalidateReauthProofs(targetId, tx);
            // Sin cuenta activa no hay relaciones asistenciales: se terminan (una reactivación NO las restaura).
            const careEnded = await endCareRelationshipsOf(tx, this.audit, {
              dentistUserId: targetId,
              actorId: actor.user.id,
              endKind: 'SYSTEM',
              reason: 'Usuario deshabilitado',
              meta,
            });
            const recoveries = await tx.passwordRecovery.updateMany({
              where: { userId: targetId, status: 'PENDING' },
              data: {
                status: 'REVOKED',
                pendingKey: null,
                revokedAt: now,
                revokedReason: 'user_disabled',
              },
            });
            await this.audit.record(
              {
                action: AuditAction.UserDisabled,
                entity: 'User',
                entityId: targetId,
                userId: actor.user.id,
                clinicId: ctx.clinicId,
                branchId: ctx.branchId,
                meta,
                summary: {
                  reason,
                  byPlatform,
                  sessionsRevoked,
                  reauthProofsInvalidated: proofsInvalidated,
                  recoveriesRevoked: recoveries.count,
                  careRelationshipsEnded: careEnded,
                  authoritiesHeld: authorities.map((a) => a.roleCode),
                },
              },
              tx,
            );
            return {
              id: targetId,
              status: 'DISABLED' as const,
              disabledAt: now,
              sessionsRevoked,
            };
          },
          { isolationLevel: 'ReadCommitted' },
        ),
      );
    } catch (error) {
      if (error instanceof DirectorProtectedError) {
        await this.audit.recordSafely({
          action: AuditAction.DirectorProtectionBlocked,
          entity: 'User',
          entityId: targetId,
          userId: actor.user.id,
          clinicId: ctx.clinicId,
          branchId: ctx.branchId,
          meta,
          summary: { operation: 'disable_user', actorRoles: actor.roles },
        });
        throw new ForbiddenException({
          message: error.message,
          code: 'DIRECTOR_PROTECTED',
        });
      }
      if (error instanceof LastAuthorityError) {
        await this.audit.recordSafely({
          action: AuditAction.LastAuthorityBlocked,
          entity: 'User',
          entityId: targetId,
          userId: actor.user.id,
          clinicId: ctx.clinicId,
          branchId: ctx.branchId,
          meta,
          summary: { blockedOperation: 'disable_user' },
        });
        throw new ConflictException({
          message: error.message,
          code: 'LAST_AUTHORITY',
        });
      }
      throw error;
    }
  }

  async reactivate(
    actor: AuthPrincipal,
    targetId: string,
    reason: string,
    meta: RequestMeta,
  ) {
    const ctx = actor.context!;
    try {
      return await withTxRetry(() =>
        this.db.$transaction(
          async (tx) => {
            const target = await tx.user.findUnique({
              where: { id: targetId },
              select: { id: true, status: true, disabledByPlatform: true },
            });
            if (!target) throw new NotFoundException('Usuario no encontrado');
            const asDirector = await this.assertDirectorProtection(
              tx,
              actor,
              targetId,
            );
            await this.assertInScope(tx, actor, targetId, {
              forDisable: false,
              asDirector,
            });
            if (target.status !== 'DISABLED')
              throw new ConflictException('La cuenta no está deshabilitada');
            // Una cuenta que deshabilitó la plataforma (p. ej. por un incidente) solo la reactiva la plataforma.
            if (target.disabledByPlatform && ctx.clinicId !== null) {
              throw new ForbiddenException(
                'Esta cuenta la deshabilitó la plataforma; solo la plataforma puede reactivarla',
              );
            }
            // Reactivación explícita: NO se restauran sesiones (las anteriores siguen revocadas); debe iniciar sesión de nuevo.
            await tx.user.update({
              where: { id: targetId },
              data: {
                status: 'ACTIVE',
                disabledAt: null,
                disabledById: null,
                disabledReason: null,
                disabledByPlatform: false,
                failedLoginAttempts: 0,
                lockedUntil: null,
              },
            });
            await this.audit.record(
              {
                action: AuditAction.UserReactivated,
                entity: 'User',
                entityId: targetId,
                userId: actor.user.id,
                clinicId: ctx.clinicId,
                branchId: ctx.branchId,
                meta,
                summary: { reason, sessionsRestored: 0 },
              },
              tx,
            );
            return { id: targetId, status: 'ACTIVE' as const };
          },
          { isolationLevel: 'ReadCommitted' },
        ),
      );
    } catch (error) {
      if (error instanceof DirectorProtectedError) {
        await this.audit.recordSafely({
          action: AuditAction.DirectorProtectionBlocked,
          entity: 'User',
          entityId: targetId,
          userId: actor.user.id,
          clinicId: ctx.clinicId,
          branchId: ctx.branchId,
          meta,
          summary: { operation: 'reactivate_user', actorRoles: actor.roles },
        });
        throw new ForbiddenException({
          message: error.message,
          code: 'DIRECTOR_PROTECTED',
        });
      }
      throw error;
    }
  }

  /**
   * ¿El destino ejerce como Director Clínico? Entonces solo otro Director vigente de ESA clínica (permiso
   * `director:manage`) puede deshabilitarlo o reactivarlo; administración y plataforma, no. Si no es Director
   * se exige `user:manage`. Devuelve si la operación se rige por la protección del Director.
   */
  private async assertDirectorProtection(
    tx: Parameters<Parameters<PrismaDb['$transaction']>[0]>[0],
    actor: AuthPrincipal,
    targetId: string,
  ): Promise<boolean> {
    const directorships = await tx.userAssignment.findMany({
      where: {
        userId: targetId,
        status: 'ACTIVE',
        role: { code: 'CLINICAL_DIRECTOR' },
      },
      select: { clinicId: true },
    });
    if (directorships.length === 0) {
      if (!actor.permissions.has('user:manage'))
        throw new ForbiddenException('No tiene permisos para esta operación');
      return false;
    }
    const clinicId = actor.context!.clinicId;
    if (
      !actor.permissions.has('director:manage') ||
      directorships.some((d) => d.clinicId !== clinicId)
    ) {
      throw new DirectorProtectedError(
        'Solo otro Director Clínico vigente de la clínica puede deshabilitar o reactivar a un Director Clínico',
      );
    }
    return true;
  }

  private async assertInScope(
    tx: Parameters<Parameters<PrismaDb['$transaction']>[0]>[0],
    actor: AuthPrincipal,
    targetId: string,
    opts: { forDisable: boolean; asDirector?: boolean },
  ): Promise<void> {
    const ctx = actor.context!;
    if (ctx.clinicId === null) return;
    const inClinic = await tx.userAssignment.count({
      where: {
        userId: targetId,
        status: 'ACTIVE',
        clinicId: ctx.clinicId,
        ...(ctx.branchId
          ? { OR: [{ branchId: null }, { branchId: ctx.branchId }] }
          : {}),
      },
    });
    if (inClinic === 0) throw new NotFoundException('Usuario no encontrado');
    if (!opts.forDisable) return;

    const outside = await tx.userAssignment.count({
      where: {
        userId: targetId,
        status: 'ACTIVE',
        OR: [{ clinicId: null }, { clinicId: { not: ctx.clinicId } }],
      },
    });
    if (outside > 0) {
      throw new ConflictException({
        message:
          'La cuenta tiene accesos en otras clínicas o en la plataforma; revoque sus asignaciones en su clínica en lugar de deshabilitarla',
        code: 'ACCOUNT_SHARED',
      });
    }
    if (ctx.branchId && !opts.asDirector) {
      const beyondBranch = await tx.userAssignment.count({
        where: {
          userId: targetId,
          status: 'ACTIVE',
          clinicId: ctx.clinicId,
          OR: [{ branchId: null }, { branchId: { not: ctx.branchId } }],
        },
      });
      if (beyondBranch > 0)
        throw new ForbiddenException(
          'Su contexto está limitado a una sede; la cuenta trabaja más allá de ella',
        );
    }
  }
}

class DirectorProtectedError extends Error {}
