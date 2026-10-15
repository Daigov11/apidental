import { ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuditAction, AuditService } from '../audit/audit.service.js';
import { generateToken, hashToken } from '../common/utils/secret-token.js';
import { verifyPassword } from '../common/utils/password.js';
import type { RequestMeta } from '../common/utils/request-meta.js';
import { AppConfig } from '../config/app-config.js';
import type { DbTx, PrismaDb } from '../prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';
import type { AuthPrincipal } from './auth.types.js';
import type { ReauthenticateDto } from './dto/reauth.dto.js';
import { LoginAttemptsService } from './login-attempts.service.js';

export const REAUTH_PREFIX = 'rp';

export const REAUTH_NOTICE =
  'Confirma que usted realiza esta acción. No es una firma digital, legal ni clínica.';

/**
 * Reautenticación: demuestra que quien tiene la sesión conoce la contraseña AHORA.
 * La prueba que se emite es de vida corta, de un solo uso y válida solo para un propósito y un
 * objeto concretos de la sesión que la pidió. **No es una firma** digital, legal ni clínica.
 */
@Injectable()
export class ReauthService {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaDb,
    private readonly audit: AuditService,
    private readonly attempts: LoginAttemptsService,
    private readonly config: AppConfig,
  ) {}

  async issue(principal: AuthPrincipal, dto: ReauthenticateDto, meta: RequestMeta) {
    const user = await this.db.user.findUnique({
      where: { id: principal.user.id },
      omit: { passwordHash: false },
    });
    if (!user || user.status !== 'ACTIVE') throw new UnauthorizedException('Contraseña incorrecta');

    const ok = await verifyPassword(user.passwordHash, dto.password);
    if (!ok || this.attempts.isLocked(user)) {
      // Cuenta como intento fallido (y bloquea): una sesión robada no puede adivinar la contraseña por aquí.
      await this.attempts.registerFailure(user.id, ok ? 'locked' : 'bad_password', meta, AuditAction.ReauthFailed);
      throw new UnauthorizedException('Contraseña incorrecta');
    }
    await this.attempts.resetFailures(user.id);

    const token = generateToken(REAUTH_PREFIX);
    const expiresAt = new Date(Date.now() + this.config.reauthTtlSeconds * 1000);
    await this.db.$transaction(async (tx) => {
      await tx.reauthProof.create({
        data: {
          userId: user.id,
          sessionId: principal.sessionId,
          purpose: dto.purpose,
          targetId: dto.targetId ?? null,
          tokenHash: hashToken(token),
          expiresAt,
          ip: meta.ip,
        },
      });
      await this.audit.record(
        {
          action: AuditAction.ReauthSucceeded,
          entity: 'ReauthProof',
          userId: user.id,
          meta,
          summary: { purpose: dto.purpose, targetId: dto.targetId ?? null, expiresAt: expiresAt.toISOString() },
        },
        tx,
      );
    });
    return {
      reauthToken: token,
      purpose: dto.purpose,
      targetId: dto.targetId ?? null,
      expiresAt,
      expiresIn: this.config.reauthTtlSeconds,
      singleUse: true,
      isSignature: false,
      notice: REAUTH_NOTICE,
    };
  }

  /**
   * Consume una prueba (la usarán el cierre de evoluciones y `clinical:read_all`). Debe llamarse
   * dentro de la transacción de la operación protegida: si ella falla, la prueba no se gasta.
   * Es válida solo si coinciden usuario, SESIÓN, propósito y objeto, no venció y no se usó.
   */
  async consume(
    actor: { userId: string; sessionId: string },
    token: unknown,
    purpose: string,
    targetId: string | null,
    meta: RequestMeta,
    tx: DbTx,
  ): Promise<void> {
    const deny = (): never => {
      throw new ForbiddenException('Reautenticación inválida, vencida o ya utilizada');
    };
    if (typeof token !== 'string' || token.length < 10 || token.length > 100) deny();
    const proof = await tx.reauthProof.findUnique({ where: { tokenHash: hashToken(token as string) } });
    if (
      !proof ||
      proof.userId !== actor.userId ||
      proof.sessionId !== actor.sessionId ||
      proof.purpose !== purpose ||
      (proof.targetId ?? null) !== targetId ||
      proof.usedAt !== null ||
      proof.expiresAt <= new Date()
    ) {
      return deny();
    }
    // Atómico: solo una operación concurrente puede gastar la prueba.
    const spent = await tx.reauthProof.updateMany({
      where: { id: proof.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (spent.count !== 1) deny();
    await this.audit.record(
      {
        action: AuditAction.ReauthConsumed,
        entity: 'ReauthProof',
        entityId: proof.id,
        userId: actor.userId,
        meta,
        summary: { purpose, targetId },
      },
      tx,
    );
  }
}
