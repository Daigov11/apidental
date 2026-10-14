import { ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuditAction, AuditService } from '../audit/audit.service.js';
import type { RequestMeta } from '../common/utils/request-meta.js';
import {
  getDummyHash,
  hashPassword,
  passwordNeedsRehash,
  verifyPassword,
} from '../common/utils/password.js';
import { AppConfig } from '../config/app-config.js';
import type { PrismaDb } from '../prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';
import { AccessService } from './access.service.js';
import type { ActiveContext, AuthPrincipal, PublicUser } from './auth.types.js';
import type { LoginDto } from './dto/login.dto.js';
import type { SelectContextDto } from './dto/select-context.dto.js';
import { TokenService } from './token.service.js';

const INVALID_CREDENTIALS = 'Credenciales inválidas';

@Injectable()
export class AuthService {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaDb,
    private readonly access: AccessService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
  ) {}

  async login(dto: LoginDto, meta: RequestMeta) {
    const user = await this.db.user.findUnique({
      where: { email: dto.email },
      omit: { passwordHash: false },
    });

    // Siempre se verifica un hash (real o de relleno) para igualar tiempos de respuesta.
    const passwordOk = await verifyPassword(user?.passwordHash ?? (await getDummyHash()), dto.password);
    if (!user) throw new UnauthorizedException(INVALID_CREDENTIALS);

    const now = new Date();
    if (user.lockedUntil && user.lockedUntil > now) {
      await this.audit.recordSafely({
        action: AuditAction.LoginBlocked,
        entity: 'User',
        entityId: user.id,
        userId: user.id,
        meta,
        summary: { reason: 'account_locked', lockedUntil: user.lockedUntil.toISOString() },
      });
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    if (!passwordOk || user.status !== 'ACTIVE') {
      await this.registerFailure(user.id, user.status, meta);
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    const newHash = passwordNeedsRehash(user.passwordHash) ? await hashPassword(dto.password) : null;
    await this.db.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: {
          failedLoginAttempts: 0,
          lockedUntil: null,
          lastLoginAt: now,
          ...(newHash ? { passwordHash: newHash } : {}),
        },
      });
      await this.audit.record(
        { action: AuditAction.LoginSuccess, entity: 'User', entityId: user.id, userId: user.id, meta },
        tx,
      );
    });

    return {
      accessToken: await this.tokens.sign(user.id),
      tokenType: 'Bearer' as const,
      expiresIn: this.tokens.expiresIn,
      user: this.toPublic(user),
      contexts: await this.access.listContexts(user.id),
    };
  }

  /** Bloqueo progresivo: cada vez que se supera el umbral el bloqueo se alarga (tope 24 h). */
  private async registerFailure(userId: string, status: string, meta: RequestMeta): Promise<void> {
    const { maxAttempts, lockMinutes } = this.config.login;
    const updated = await this.db.user.update({
      where: { id: userId },
      data: { failedLoginAttempts: { increment: 1 } },
      select: { failedLoginAttempts: true },
    });
    const attempts = updated.failedLoginAttempts;
    await this.audit.recordSafely({
      action: AuditAction.LoginFailed,
      entity: 'User',
      entityId: userId,
      userId,
      meta,
      summary: { attempts, reason: status === 'ACTIVE' ? 'bad_password' : 'user_disabled' },
    });

    if (attempts >= maxAttempts) {
      const cycles = Math.floor(attempts / maxAttempts);
      const minutes = Math.min(lockMinutes * cycles, 1440);
      const lockedUntil = new Date(Date.now() + minutes * 60_000);
      await this.db.user.update({ where: { id: userId }, data: { lockedUntil } });
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

  async selectContext(principal: AuthPrincipal, dto: SelectContextDto, meta: RequestMeta) {
    const context: ActiveContext = { clinicId: dto.clinicId ?? null, branchId: dto.branchId ?? null };
    const resolved =
      context.clinicId === null && context.branchId !== null
        ? null
        : await this.access.resolve(principal.user.id, context);

    if (!resolved) {
      await this.audit.recordSafely({
        action: AuditAction.ContextDenied,
        entity: 'User',
        entityId: principal.user.id,
        userId: principal.user.id,
        clinicId: context.clinicId,
        branchId: context.branchId,
        meta,
        summary: { requested: context },
      });
      throw new ForbiddenException('No tiene una asignación activa para ese contexto');
    }

    await this.audit.record({
      action: AuditAction.ContextSelected,
      entity: 'User',
      entityId: principal.user.id,
      userId: principal.user.id,
      clinicId: context.clinicId,
      branchId: context.branchId,
      meta,
      summary: { roles: resolved.roles },
    });

    return {
      accessToken: await this.tokens.sign(principal.user.id, context),
      tokenType: 'Bearer' as const,
      expiresIn: this.tokens.expiresIn,
      context: await this.describeContext(context),
      roles: resolved.roles,
      permissions: [...resolved.permissions].sort(),
    };
  }

  async me(principal: AuthPrincipal) {
    return {
      user: principal.user,
      context: principal.context ? await this.describeContext(principal.context) : null,
      roles: principal.roles,
      permissions: [...principal.permissions].sort(),
    };
  }

  contexts(principal: AuthPrincipal) {
    return this.access.listContexts(principal.user.id);
  }

  private async describeContext(context: ActiveContext) {
    const [clinic, branch] = await Promise.all([
      context.clinicId
        ? this.db.clinic.findUnique({ where: { id: context.clinicId }, select: { id: true, name: true } })
        : null,
      context.branchId
        ? this.db.branch.findUnique({ where: { id: context.branchId }, select: { id: true, name: true } })
        : null,
    ]);
    return { platform: context.clinicId === null, clinic, branch };
  }

  private toPublic(user: PublicUser): PublicUser {
    return { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName };
  }
}
