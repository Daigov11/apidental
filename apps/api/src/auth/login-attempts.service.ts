import { Inject, Injectable } from '@nestjs/common';
import { AuditAction, AuditService } from '../audit/audit.service.js';
import type { RequestMeta } from '../common/utils/request-meta.js';
import { AppConfig } from '../config/app-config.js';
import type { PrismaDb } from '../prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';

/**
 * Bloqueo progresivo compartido por todo lo que verifica una contraseña (login, reautenticación,
 * aceptación de invitación de una cuenta existente): un token robado no sirve para adivinar la clave.
 */
@Injectable()
export class LoginAttemptsService {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaDb,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
  ) {}

  isLocked(user: { lockedUntil: Date | null }, now = new Date()): boolean {
    return Boolean(user.lockedUntil && user.lockedUntil > now);
  }

  /** Cada vez que se supera el umbral el bloqueo se alarga (tope 24 h). */
  async registerFailure(
    userId: string,
    reason: string,
    meta: RequestMeta,
    failedAction: string = AuditAction.LoginFailed,
  ): Promise<void> {
    const { maxAttempts, lockMinutes } = this.config.login;
    const updated = await this.db.user.update({
      where: { id: userId },
      data: { failedLoginAttempts: { increment: 1 } },
      select: { failedLoginAttempts: true },
    });
    const attempts = updated.failedLoginAttempts;
    await this.audit.recordSafely({
      action: failedAction,
      entity: 'User',
      entityId: userId,
      userId,
      meta,
      summary: { attempts, reason },
    });
    if (attempts >= maxAttempts) {
      const minutes = Math.min(lockMinutes * Math.floor(attempts / maxAttempts), 1440);
      await this.db.user.update({ where: { id: userId }, data: { lockedUntil: new Date(Date.now() + minutes * 60_000) } });
      await this.audit.recordSafely({
        action: AuditAction.LoginLocked,
        entity: 'User',
        entityId: userId,
        userId,
        meta,
        summary: { attempts, lockedMinutes: minutes },
      });
    }
  }

  resetFailures(userId: string): Promise<unknown> {
    return this.db.user.update({ where: { id: userId }, data: { failedLoginAttempts: 0, lockedUntil: null } });
  }
}
