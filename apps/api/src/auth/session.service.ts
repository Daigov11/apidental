import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuditAction, AuditService } from '../audit/audit.service.js';
import { generateToken, hashToken, looksLikeToken } from '../common/utils/secret-token.js';
import type { RequestMeta } from '../common/utils/request-meta.js';
import { AppConfig } from '../config/app-config.js';
import type { DbTx, PrismaDb } from '../prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';
import type { ActiveContext } from './auth.types.js';

export const REFRESH_PREFIX = 'rt';

/** El rechazo de un refresh token siempre es el mismo 401: no revela si el token existió o por qué falló. */
export class RefreshRejectedException extends UnauthorizedException {
  constructor() {
    super('Sesión inválida o vencida');
  }
}

export interface RotationResult {
  userId: string;
  sessionId: string;
  /** Nuevo refresh token (se entrega solo por cookie). null si fue una renovación tolerada dentro de la ventana de gracia. */
  refreshToken: string | null;
  context: ActiveContext | null;
}

/**
 * Sesiones y refresh tokens. Una sesión es la "familia" de sus tokens:
 *  - el refresh token rota en cada uso (el anterior queda ROTATED y se conserva);
 *  - presentar uno ya rotado = reutilización (posible robo) => se revoca la sesión completa;
 *  - solo se guarda el SHA-256 de cada token.
 */
@Injectable()
export class SessionService {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaDb,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
  ) {}

  async create(userId: string, meta: RequestMeta, tx?: DbTx): Promise<{ sessionId: string; refreshToken: string }> {
    const db = tx ?? this.db;
    const now = Date.now();
    const absoluteExpiresAt = new Date(now + this.config.session.absoluteSeconds * 1000);
    const session = await db.authSession.create({
      data: { userId, absoluteExpiresAt, ip: meta.ip, userAgent: meta.userAgent },
      select: { id: true },
    });
    const refreshToken = await this.issueToken(db, session.id, absoluteExpiresAt);
    return { sessionId: session.id, refreshToken };
  }

  private async issueToken(db: DbTx, sessionId: string, absoluteExpiresAt: Date): Promise<string> {
    const token = generateToken(REFRESH_PREFIX);
    const idleExpiry = Date.now() + this.config.session.refreshTtlSeconds * 1000;
    await db.refreshToken.create({
      data: {
        sessionId,
        tokenHash: hashToken(token),
        expiresAt: new Date(Math.min(idleExpiry, absoluteExpiresAt.getTime())),
      },
    });
    return token;
  }

  /** ¿La sesión sigue vigente? La usa el guard en cada solicitud, por eso el logout surte efecto al instante. */
  async isActive(sessionId: string, userId: string): Promise<boolean> {
    const s = await this.db.authSession.findUnique({
      where: { id: sessionId },
      select: { userId: true, revokedAt: true, absoluteExpiresAt: true },
    });
    return Boolean(s && s.userId === userId && !s.revokedAt && s.absoluteExpiresAt > new Date());
  }

  async setContext(sessionId: string, context: ActiveContext): Promise<void> {
    await this.db.authSession.update({
      where: { id: sessionId },
      data: { contextSet: true, contextClinicId: context.clinicId, contextBranchId: context.branchId },
    });
  }

  async clearContext(sessionId: string): Promise<void> {
    await this.db.authSession.update({
      where: { id: sessionId },
      data: { contextSet: false, contextClinicId: null, contextBranchId: null },
    });
  }

  /** Renueva: invalida el token presentado y entrega uno nuevo. */
  async rotate(token: unknown, meta: RequestMeta): Promise<RotationResult> {
    if (!looksLikeToken(token, REFRESH_PREFIX)) throw new RefreshRejectedException();
    const hash = hashToken(token);
    const now = new Date();

    const current = await this.db.refreshToken.findUnique({
      where: { tokenHash: hash },
      include: { session: true },
    });
    if (!current) throw new RefreshRejectedException();
    const session = current.session;
    if (session.revokedAt || session.absoluteExpiresAt <= now) throw new RefreshRejectedException();

    if (current.status !== 'ACTIVE') return this.handleReuse(current, session, meta, now);

    if (current.expiresAt <= now) {
      await this.revokeSession(session.id, 'EXPIRED');
      throw new RefreshRejectedException();
    }

    const user = await this.db.user.findUnique({ where: { id: session.userId }, select: { id: true, status: true } });
    if (!user || user.status !== 'ACTIVE') {
      await this.revokeSession(session.id, 'USER_DISABLED');
      throw new RefreshRejectedException();
    }

    // Rotación atómica: solo UNA solicitud concurrente puede pasar de ACTIVE a ROTATED.
    const rotated = await this.db.$transaction(async (tx) => {
      const flipped = await tx.refreshToken.updateMany({
        where: { id: current.id, status: 'ACTIVE' },
        data: { status: 'ROTATED', rotatedAt: now },
      });
      if (flipped.count !== 1) return null;
      const next = await this.issueToken(tx, session.id, session.absoluteExpiresAt);
      const nextRow = await tx.refreshToken.findUniqueOrThrow({ where: { tokenHash: hashToken(next) }, select: { id: true } });
      await tx.refreshToken.update({ where: { id: current.id }, data: { replacedById: nextRow.id } });
      await tx.authSession.update({ where: { id: session.id }, data: { lastUsedAt: now } });
      return next;
    });
    if (rotated === null) {
      // Otra solicitud ganó la carrera con el mismo token: se trata como reutilización.
      const fresh = await this.db.refreshToken.findUniqueOrThrow({ where: { id: current.id }, include: { session: true } });
      return this.handleReuse(fresh, fresh.session, meta, now);
    }
    return {
      userId: session.userId,
      sessionId: session.id,
      refreshToken: rotated,
      context: session.contextSet ? { clinicId: session.contextClinicId, branchId: session.contextBranchId } : null,
    };
  }

  /**
   * Un refresh token ya rotado se presentó de nuevo. Dos lecturas posibles: robo (alguien tiene una
   * copia) o dos pestañas renovando a la vez. Por defecto (gracia = 0) siempre se asume robo y se
   * revoca la sesión entera, de modo que el atacante y la víctima deben volver a iniciar sesión.
   */
  private async handleReuse(
    current: { id: string; status: string; rotatedAt: Date | null; replacedById: string | null },
    session: { id: string; userId: string; contextSet: boolean; contextClinicId: string | null; contextBranchId: string | null },
    meta: RequestMeta,
    now: Date,
  ): Promise<RotationResult> {
    const grace = this.config.session.reuseGraceSeconds * 1000;
    if (grace > 0 && current.status === 'ROTATED' && current.rotatedAt && now.getTime() - current.rotatedAt.getTime() <= grace) {
      const successor = current.replacedById
        ? await this.db.refreshToken.findUnique({ where: { id: current.replacedById }, select: { status: true } })
        : null;
      if (successor?.status === 'ACTIVE') {
        // Renovación simultánea legítima: se entrega solo un access token; la cookie nueva ya la tiene el cliente.
        return {
          userId: session.userId,
          sessionId: session.id,
          refreshToken: null,
          context: session.contextSet ? { clinicId: session.contextClinicId, branchId: session.contextBranchId } : null,
        };
      }
    }
    await this.db.$transaction(async (tx) => {
      await this.revokeSession(session.id, 'REUSE_DETECTED', tx);
      await this.audit.record(
        {
          action: AuditAction.RefreshReuseDetected,
          entity: 'AuthSession',
          entityId: session.id,
          userId: session.userId,
          meta,
          summary: { sessionId: session.id, tokenId: current.id },
        },
        tx,
      );
    });
    throw new RefreshRejectedException();
  }

  /** Revoca la sesión y todos sus refresh tokens. Idempotente. */
  async revokeSession(
    sessionId: string,
    reason: 'LOGOUT' | 'LOGOUT_ALL' | 'REUSE_DETECTED' | 'EXPIRED' | 'USER_DISABLED',
    tx?: DbTx,
  ): Promise<boolean> {
    const db = tx ?? this.db;
    const res = await db.authSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    await db.refreshToken.updateMany({ where: { sessionId, status: 'ACTIVE' }, data: { status: 'REVOKED' } });
    return res.count === 1;
  }

  /** Cierra todas las sesiones del usuario (incluida la actual). Devuelve cuántas estaban activas. */
  async revokeAllForUser(userId: string, reason: 'LOGOUT_ALL' | 'USER_DISABLED', tx?: DbTx): Promise<number> {
    const db = tx ?? this.db;
    const active = await db.authSession.findMany({ where: { userId, revokedAt: null }, select: { id: true } });
    let count = 0;
    for (const s of active) if (await this.revokeSession(s.id, reason, tx)) count += 1;
    return count;
  }

  /** Para el logout con solo cookie: a qué sesión pertenece un refresh token (sin importar su estado). */
  async sessionOfRefreshToken(token: unknown): Promise<{ sessionId: string; userId: string } | null> {
    if (!looksLikeToken(token, REFRESH_PREFIX)) return null;
    const row = await this.db.refreshToken.findUnique({
      where: { tokenHash: hashToken(token) },
      select: { session: { select: { id: true, userId: true } } },
    });
    return row ? { sessionId: row.session.id, userId: row.session.userId } : null;
  }
}
