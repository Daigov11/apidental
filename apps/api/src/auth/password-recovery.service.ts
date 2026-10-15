import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
} from '@nestjs/common';
import { AuditAction, AuditService } from '../audit/audit.service.js';
import { hashPassword, verifyPassword } from '../common/utils/password.js';
import { passwordPolicyErrors } from '../common/utils/password-policy.js';
import type { RequestMeta } from '../common/utils/request-meta.js';
import { generateToken, hashToken, looksLikeToken } from '../common/utils/secret-token.js';
import { AppConfig } from '../config/app-config.js';
import { INVITATION_DELIVERY, type InvitationDelivery } from '../invitations/delivery/invitation-delivery.js';
import type { DbTx, PrismaDb } from '../prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';
import type { ConfirmPasswordRecoveryDto } from './dto/password-recovery.dto.js';
import { SessionService } from './session.service.js';

export const RECOVERY_PREFIX = 'pr';

/** Respuesta ÚNICA de la solicitud: idéntica exista o no la cuenta, esté activa o no. */
export const RECOVERY_NEUTRAL_MESSAGE =
  'Si el correo corresponde a una cuenta activa, le enviaremos instrucciones para restablecer su contraseña.';
const INVALID_LINK = 'Enlace de recuperación inválido o vencido';

class RecoveryUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

const isUniqueViolation = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';

/**
 * Recuperación de contraseña. Garantías:
 *  - La solicitud responde SIEMPRE lo mismo y de inmediato; el trabajo (consulta, token, entrega) se
 *    hace después de responder, así que ni el contenido ni el tiempo revelan si el correo existe.
 *  - Token de 256 bits de un solo uso, vida corta (30 min), solo su SHA-256 en la base; una pendiente por
 *    usuario (pedir otra revoca la anterior). El token solo viaja por el canal de entrega firmado.
 *  - Límites silenciosos por cuenta (enfriamiento y tope diario) además del límite por IP.
 *  - Al restablecer: nueva contraseña (política), TODAS las sesiones y refresh tokens del usuario se
 *    revocan, se invalidan sus pruebas de reautenticación, y se revocan las invitaciones y otras
 *    recuperaciones pendientes relacionadas. No inicia sesión automáticamente.
 */
@Injectable()
export class PasswordRecoveryService implements OnModuleDestroy {
  private readonly logger = new Logger(PasswordRecoveryService.name);
  private readonly inflight = new Set<Promise<void>>();

  constructor(
    @Inject(PRISMA) private readonly db: PrismaDb,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
    private readonly sessions: SessionService,
    @Inject(INVITATION_DELIVERY) private readonly delivery: InvitationDelivery,
  ) {}

  // =============================================================== solicitud

  /** Responde ya; el trabajo real continúa en segundo plano (sin bloquear ni diferenciar casos). */
  request(email: string, meta: RequestMeta): { message: string } {
    let task: Promise<void>;
    task = this.process(email, meta)
      .catch((error) => {
        // Nunca se registra el correo ni el token: solo el tipo de error.
        this.logger.error({ msg: 'Fallo al procesar una recuperación de contraseña', error: error instanceof Error ? error.name : 'desconocido' });
      })
      .finally(() => this.inflight.delete(task));
    this.inflight.add(task);
    return { message: RECOVERY_NEUTRAL_MESSAGE };
  }

  /** Espera el trabajo en curso (cierre ordenado y pruebas). */
  async idle(): Promise<void> {
    await Promise.allSettled(this.inflight);
  }

  async onModuleDestroy(): Promise<void> {
    await this.idle();
  }

  private async process(email: string, meta: RequestMeta): Promise<void> {
    const user = await this.db.user.findUnique({ where: { email }, select: { id: true, email: true, status: true } });
    if (!user || user.status !== 'ACTIVE') return; // en silencio: sin token, sin auditoría, sin diferencias visibles

    const { cooldownSeconds, maxPerDay, ttlMinutes } = this.config.passwordRecovery;
    const now = new Date();
    const recent = await this.db.passwordRecovery.findMany({
      where: { userId: user.id, createdAt: { gte: new Date(now.getTime() - 86_400_000) } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (recent.length >= maxPerDay) return;
    if (cooldownSeconds > 0 && recent[0] && now.getTime() - recent[0].createdAt.getTime() < cooldownSeconds * 1000) return;

    const token = generateToken(RECOVERY_PREFIX);
    const expiresAt = new Date(now.getTime() + ttlMinutes * 60_000);
    let recoveryId: string;
    try {
      recoveryId = await this.db.$transaction(async (tx) => {
        // Pedir otra recuperación revoca la pendiente anterior (su enlace deja de valer).
        await tx.passwordRecovery.updateMany({
          where: { userId: user.id, status: 'PENDING' },
          data: { status: 'REVOKED', pendingKey: null, revokedAt: now, revokedReason: 'superseded' },
        });
        const created = await tx.passwordRecovery.create({
          data: {
            userId: user.id,
            tokenHash: hashToken(token),
            pendingKey: user.id,
            expiresAt,
            requestIp: meta.ip,
            requestUserAgent: meta.userAgent,
          },
          select: { id: true },
        });
        await this.audit.record(
          { action: AuditAction.PasswordRecoveryRequested, entity: 'PasswordRecovery', entityId: created.id, userId: user.id, meta, summary: { expiresAt: expiresAt.toISOString() } },
          tx,
        );
        return created.id;
      });
    } catch (error) {
      if (isUniqueViolation(error)) return; // solicitud concurrente: la otra ya creó la pendiente
      throw error;
    }

    const outcome = await this.delivery.deliver({
      type: 'password_recovery',
      recoveryId,
      toEmail: user.email,
      resetUrl: `${this.config.passwordRecovery.baseUrl}#token=${token}`,
      expiresAt,
    });
    if (outcome.ok) {
      await this.db.passwordRecovery.update({
        where: { id: recoveryId },
        data: { deliveryStatus: 'SENT', deliveryAttempts: { increment: 1 }, lastDeliveryAt: new Date() },
      });
      await this.audit.recordSafely({ action: AuditAction.PasswordRecoverySent, entity: 'PasswordRecovery', entityId: recoveryId, userId: user.id, meta, summary: { channel: this.delivery.mode } });
    } else {
      await this.db.passwordRecovery.update({
        where: { id: recoveryId },
        data: { deliveryStatus: 'FAILED', deliveryAttempts: { increment: 1 }, lastDeliveryAt: new Date(), lastDeliveryError: outcome.reason.slice(0, 120) },
      });
      await this.audit.recordSafely({ action: AuditAction.PasswordRecoveryDeliveryFailed, entity: 'PasswordRecovery', entityId: recoveryId, userId: user.id, meta, summary: { channel: this.delivery.mode, reason: outcome.reason } });
    }
  }

  // ============================================================ validar / confirmar

  /** ¿El enlace sigue vigente? Todo fallo responde igual. */
  async validate(token: unknown) {
    const rec = await this.findByToken(token);
    if (!rec || rec.status !== 'PENDING') throw new NotFoundException(INVALID_LINK);
    if (rec.expiresAt <= new Date()) {
      await this.markExpired(rec.id, rec.userId);
      throw new NotFoundException(INVALID_LINK);
    }
    if (rec.user.status !== 'ACTIVE') throw new NotFoundException(INVALID_LINK);
    return { valid: true, expiresAt: rec.expiresAt };
  }

  async confirm(dto: ConfirmPasswordRecoveryDto, meta: RequestMeta) {
    const rec = await this.findByToken(dto.token);
    if (!rec) throw new NotFoundException(INVALID_LINK);
    const now = new Date();
    if (rec.status !== 'PENDING') {
      await this.rejected(rec.id, rec.userId, `status_${rec.status.toLowerCase()}`, meta);
      throw new NotFoundException(INVALID_LINK);
    }
    if (rec.expiresAt <= now) {
      await this.markExpired(rec.id, rec.userId);
      throw new NotFoundException(INVALID_LINK);
    }
    if (rec.user.status !== 'ACTIVE') {
      await this.rejected(rec.id, rec.userId, 'user_disabled', meta);
      throw new NotFoundException(INVALID_LINK);
    }

    // La política se valida SIN consumir el enlace: la persona puede reintentar con otra contraseña.
    const errors = passwordPolicyErrors(dto.newPassword, { email: rec.user.email });
    if (errors.length > 0) throw new BadRequestException(errors);
    if (await verifyPassword(rec.user.passwordHash, dto.newPassword)) {
      throw new BadRequestException(['La nueva contraseña debe ser distinta de la actual']);
    }
    const newHash = await hashPassword(dto.newPassword);

    try {
      // READ COMMITTED: cada lectura posterior al bloqueo ve lo ya confirmado (ver invitaciones).
      await this.db.$transaction((tx) => this.applyReset(tx, rec.id, rec.userId, rec.user.email, newHash, meta, now), {
        isolationLevel: 'ReadCommitted',
      });
    } catch (error) {
      if (error instanceof RecoveryUnavailableError) {
        await this.rejected(rec.id, rec.userId, error.reason, meta);
        throw new NotFoundException(INVALID_LINK);
      }
      throw error;
    }
    return { reset: true };
  }

  private async applyReset(tx: DbTx, recoveryId: string, userId: string, email: string, newHash: string, meta: RequestMeta, now: Date) {
    const locked = await tx.$queryRaw<{ status: string; expires_at: Date }[]>`
      SELECT status, expires_at FROM password_recoveries WHERE id = ${recoveryId} FOR UPDATE`;
    if (!locked[0] || locked[0].status !== 'PENDING' || locked[0].expires_at <= now) throw new RecoveryUnavailableError('unavailable');
    const user = await tx.user.findUnique({ where: { id: userId }, select: { status: true } });
    if (!user || user.status !== 'ACTIVE') throw new RecoveryUnavailableError('user_disabled');

    await tx.user.update({ where: { id: userId }, data: { passwordHash: newHash, failedLoginAttempts: 0, lockedUntil: null } });
    await tx.passwordRecovery.update({
      where: { id: recoveryId },
      data: { status: 'USED', pendingKey: null, usedAt: now, usedIp: meta.ip },
    });
    const otherRecoveries = await tx.passwordRecovery.updateMany({
      where: { userId, status: 'PENDING' },
      data: { status: 'REVOKED', pendingKey: null, revokedAt: now, revokedReason: 'password_reset' },
    });
    // Todas las sesiones y refresh tokens del usuario, y sus pruebas de reautenticación pendientes.
    const sessionsRevoked = await this.sessions.revokeAllForUser(userId, 'PASSWORD_RESET', tx);
    await this.sessions.invalidateReauthProofs(userId, tx);
    // Invitaciones pendientes dirigidas a esta cuenta: se revocan (podrían haberse emitido a una cuenta comprometida).
    const invitations = await tx.invitation.findMany({ where: { email, status: 'PENDING' }, select: { id: true, clinicId: true, branchId: true } });
    for (const inv of invitations) {
      await tx.invitation.update({
        where: { id: inv.id },
        data: { status: 'REVOKED', pendingKey: null, revokedAt: now, revokedById: userId, revokeReason: 'Restablecimiento de contraseña de la cuenta' },
      });
      await this.audit.record(
        { action: AuditAction.InvitationRevoked, entity: 'Invitation', entityId: inv.id, userId, clinicId: inv.clinicId, branchId: inv.branchId, meta, summary: { cause: 'password_reset' } },
        tx,
      );
    }
    await this.audit.record(
      {
        action: AuditAction.PasswordRecoveryCompleted,
        entity: 'User',
        entityId: userId,
        userId,
        meta,
        summary: { sessionsRevoked, invitationsRevoked: invitations.length, recoveriesRevoked: otherRecoveries.count },
      },
      tx,
    );
  }

  // ================================================================== internos

  private async findByToken(token: unknown) {
    if (!looksLikeToken(token, RECOVERY_PREFIX)) return null;
    return this.db.passwordRecovery.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: { omit: { passwordHash: false } } },
    });
  }

  private async rejected(recoveryId: string, userId: string, reason: string, meta: RequestMeta) {
    await this.audit.recordSafely({
      action: AuditAction.PasswordRecoveryRejected,
      entity: 'PasswordRecovery',
      entityId: recoveryId,
      userId,
      meta,
      summary: { reason },
    });
  }

  /** PENDING → EXPIRED una sola vez (condicional) y auditado una sola vez. */
  private async markExpired(id: string, userId: string): Promise<void> {
    const res = await this.db.passwordRecovery.updateMany({
      where: { id, status: 'PENDING', expiresAt: { lte: new Date() } },
      data: { status: 'EXPIRED', pendingKey: null, expiredAt: new Date() },
    });
    if (res.count === 1) {
      await this.audit.recordSafely({ action: AuditAction.PasswordRecoveryExpired, entity: 'PasswordRecovery', entityId: id, userId });
    }
  }

  /** Vence en lote las recuperaciones cuyo plazo terminó. */
  async expireDue(): Promise<number> {
    const due = await this.db.passwordRecovery.findMany({
      where: { status: 'PENDING', expiresAt: { lte: new Date() } },
      select: { id: true, userId: true },
      take: this.config.maintenance.batchSize,
    });
    for (const r of due) await this.markExpired(r.id, r.userId);
    return due.length;
  }
}
