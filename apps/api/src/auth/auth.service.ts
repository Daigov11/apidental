import { ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuditAction, AuditService } from '../audit/audit.service.js';
import type { RequestMeta } from '../common/utils/request-meta.js';
import {
  getDummyHash,
  hashPassword,
  passwordNeedsRehash,
  verifyPassword,
} from '../common/utils/password.js';
import type { PrismaDb } from '../prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';
import { AccessService } from './access.service.js';
import type { ActiveContext, AuthPrincipal, PublicUser } from './auth.types.js';
import type { LoginDto } from './dto/login.dto.js';
import type { SelectContextDto } from './dto/select-context.dto.js';
import { LoginAttemptsService } from './login-attempts.service.js';
import { SessionService } from './session.service.js';
import { TokenService } from './token.service.js';

const INVALID_CREDENTIALS = 'Credenciales inválidas';

@Injectable()
export class AuthService {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaDb,
    private readonly access: AccessService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly attempts: LoginAttemptsService,
    private readonly sessions: SessionService,
  ) {}

  /**
   * Devuelve `body` (lo que va en la respuesta JSON) y `refreshToken` (que el controlador entrega
   * SOLO por cookie HttpOnly). Están separados a propósito para que el token no se filtre al cuerpo.
   */
  async login(dto: LoginDto, meta: RequestMeta) {
    const user = await this.db.user.findUnique({
      where: { email: dto.email },
      omit: { passwordHash: false },
    });

    // Siempre se verifica un hash (real o de relleno) para igualar tiempos de respuesta.
    const passwordOk = await verifyPassword(user?.passwordHash ?? (await getDummyHash()), dto.password);
    if (!user) throw new UnauthorizedException(INVALID_CREDENTIALS);

    const now = new Date();
    if (this.attempts.isLocked(user, now)) {
      await this.audit.recordSafely({
        action: AuditAction.LoginBlocked,
        entity: 'User',
        entityId: user.id,
        userId: user.id,
        meta,
        summary: { reason: 'account_locked', lockedUntil: user.lockedUntil!.toISOString() },
      });
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    if (!passwordOk || user.status !== 'ACTIVE') {
      await this.attempts.registerFailure(user.id, user.status === 'ACTIVE' ? 'bad_password' : 'user_disabled', meta);
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    const newHash = passwordNeedsRehash(user.passwordHash) ? await hashPassword(dto.password) : null;
    const session = await this.db.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: {
          failedLoginAttempts: 0,
          lockedUntil: null,
          lastLoginAt: now,
          ...(newHash ? { passwordHash: newHash } : {}),
        },
      });
      const created = await this.sessions.create(user.id, meta, tx);
      await this.audit.record(
        {
          action: AuditAction.LoginSuccess,
          entity: 'User',
          entityId: user.id,
          userId: user.id,
          meta,
          summary: { sessionId: created.sessionId },
        },
        tx,
      );
      return created;
    });

    return {
      refreshToken: session.refreshToken,
      body: {
        accessToken: await this.tokens.sign(user.id, session.sessionId),
        tokenType: 'Bearer' as const,
        expiresIn: this.tokens.expiresIn,
        user: this.toPublic(user),
        contexts: await this.access.listContexts(user.id),
      },
    };
  }

  /** Renueva el access token a partir del refresh token (cookie). Restaura el contexto si sigue siendo válido. */
  async refresh(refreshToken: unknown, meta: RequestMeta) {
    const rotated = await this.sessions.rotate(refreshToken, meta);
    let context: ActiveContext | null = rotated.context;
    if (context && !(await this.access.resolve(rotated.userId, context))) {
      // El contexto guardado ya no es válido (asignación revocada, sede inactiva…): se vuelve a elegir.
      await this.sessions.clearContext(rotated.sessionId);
      context = null;
    }
    return {
      refreshToken: rotated.refreshToken,
      body: {
        accessToken: await this.tokens.sign(rotated.userId, rotated.sessionId, context ?? undefined),
        tokenType: 'Bearer' as const,
        expiresIn: this.tokens.expiresIn,
        context: context ? await this.describeContext(context) : null,
      },
    };
  }

  /** Cierra la sesión actual (por access token) y/o la del refresh token presentado. */
  async logout(sessionIds: { sessionId: string; userId: string }[], meta: RequestMeta): Promise<void> {
    const seen = new Set<string>();
    for (const s of sessionIds) {
      if (seen.has(s.sessionId)) continue;
      seen.add(s.sessionId);
      const revoked = await this.sessions.revokeSession(s.sessionId, 'LOGOUT');
      if (revoked) {
        await this.audit.recordSafely({
          action: AuditAction.SessionLogout,
          entity: 'AuthSession',
          entityId: s.sessionId,
          userId: s.userId,
          meta,
          summary: { sessionId: s.sessionId },
        });
      }
    }
  }

  async logoutAll(principal: AuthPrincipal, meta: RequestMeta): Promise<number> {
    const count = await this.sessions.revokeAllForUser(principal.user.id, 'LOGOUT_ALL');
    await this.audit.recordSafely({
      action: AuditAction.SessionLogoutAll,
      entity: 'User',
      entityId: principal.user.id,
      userId: principal.user.id,
      meta,
      summary: { sessionsRevoked: count },
    });
    return count;
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
    await this.sessions.setContext(principal.sessionId, context);

    return {
      accessToken: await this.tokens.sign(principal.user.id, principal.sessionId, context),
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
