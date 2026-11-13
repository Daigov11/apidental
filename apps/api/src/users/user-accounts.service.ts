import { randomInt } from 'node:crypto';
import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AuditAction, AuditService } from '../audit/audit.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { CARE_ATTENDANCE_PERMISSIONS, RETIRED_ROLE_CODES } from '../auth/permissions.js';
import { SessionService } from '../auth/session.service.js';
import { hashPassword } from '../common/utils/password.js';
import type { RequestMeta } from '../common/utils/request-meta.js';
import { isUniqueViolation } from '../patients/patient-access.js';
import type { PrismaDb } from '../prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';
import { AssignmentsService } from './assignments.service.js';

/** Sin caracteres que se confunden al dictarlos o copiarlos a mano (0/O, 1/l/I). */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const GROUPS = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnpqrstuvwxyz', '23456789'];

/** Contraseña aleatoria de 14 caracteres (al menos una mayúscula, una minúscula y un número). */
export function generatePassword(length = 14): string {
  for (;;) {
    const p = Array.from({ length }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
    if (GROUPS.every((g) => p.split('').some((ch) => g.includes(ch)))) return p;
  }
}

/**
 * Alta directa de usuarios del sistema y restablecimiento de su contraseña por un administrador.
 * Las contraseñas se guardan SOLO como hash argon2id: no se pueden leer después. Por eso la contraseña generada se
 * devuelve una única vez, en la respuesta de la operación, y nunca se registra en la auditoría ni en los logs.
 * Las cuentas de Apiworking no tienen contraseña local: la suya la gestiona Apiworking.
 */
@Injectable()
export class UserAccountsService {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaDb,
    private readonly audit: AuditService,
    private readonly assignments: AssignmentsService,
    private readonly sessions: SessionService,
  ) {}

  async create(
    actor: AuthPrincipal,
    dto: { email: string; firstName: string; lastName: string; roleCode: string; clinicId?: string; branchId?: string; password?: string },
    meta: RequestMeta,
  ) {
    // Mismas reglas que al asignar un rol: anti-escalada, nunca Director Clínico, dentro de la clínica y sede del administrador.
    const grant = await this.assignments.validateGrant(actor, { roleCode: dto.roleCode, clinicId: dto.clinicId, branchId: dto.branchId });
    if (RETIRED_ROLE_CODES.includes(grant.roleCode)) throw new ForbiddenException('Ese rol ya no se usa: elija Administrador, Cajero u Odontólogo');
    const email = dto.email.trim().toLowerCase();
    if (await this.db.user.findUnique({ where: { email }, select: { id: true } })) {
      throw new ConflictException({ message: 'Ya existe un usuario con ese correo: asígnele el rol desde la lista', code: 'EMAIL_TAKEN' });
    }
    const generated = !dto.password;
    const password = dto.password ?? generatePassword();
    const passwordHash = await hashPassword(password);
    try {
      const user = await this.db.$transaction(async (tx) => {
        const u = await tx.user.create({
          data: { email, firstName: dto.firstName.trim(), lastName: dto.lastName.trim(), passwordHash },
          select: { id: true, email: true, firstName: true, lastName: true, status: true, createdAt: true },
        });
        await this.assignments.persist(actor.user.id, u.id, grant, meta, tx);
        await this.audit.record(
          {
            action: AuditAction.UserCreated,
            entity: 'User',
            entityId: u.id,
            userId: actor.user.id,
            clinicId: grant.clinicId,
            branchId: grant.branchId,
            meta,
            summary: { via: 'admin', roleCode: grant.roleCode, passwordGenerated: generated },
          },
          tx,
        );
        return u;
      });
      return { user, ...(generated ? { password } : {}) };
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException({ message: 'Ya existe un usuario con ese correo', code: 'EMAIL_TAKEN' });
      throw error;
    }
  }

  async resetPassword(actor: AuthPrincipal, targetId: string, dto: { password?: string }, meta: RequestMeta) {
    if (targetId === actor.user.id) {
      throw new ForbiddenException('Para cambiar su propia contraseña use «¿Olvidó su contraseña?» en el ingreso');
    }
    const ctx = actor.context!;
    const target = await this.db.user.findUnique({
      where: { id: targetId },
      select: {
        id: true,
        status: true,
        externalIdentity: { select: { id: true } },
        assignments: {
          where: { status: 'ACTIVE' },
          select: { clinicId: true, branchId: true, role: { select: { code: true, permissions: { select: { permission: { select: { code: true } } } } } } },
        },
      },
    });
    if (!target) throw new NotFoundException('Usuario no encontrado');
    if (target.externalIdentity) {
      throw new ConflictException({ message: 'La contraseña de esta cuenta es la de Apiworking: se cambia en Apiworking', code: 'EXTERNAL_ACCOUNT' });
    }
    // Alcance: una clínica solo restablece a quien trabaja en ella (y en su sede, si el contexto la fija).
    const inScope = (a: { clinicId: string | null; branchId: string | null }) =>
      ctx.clinicId === null || (a.clinicId === ctx.clinicId && (!ctx.branchId || a.branchId === null || a.branchId === ctx.branchId));
    if (ctx.clinicId !== null && !target.assignments.some(inScope)) throw new NotFoundException('Usuario no encontrado');
    // Anti-escalada: no se toma control de una cuenta con más autoridad que la propia (p. ej. el Director Clínico,
    // otro administrador de plataforma). Los permisos de atención no confieren acceso por sí solos (ver AssignmentsService).
    const attendance = CARE_ATTENDANCE_PERMISSIONS as readonly string[];
    const stronger = target.assignments.some((a) => a.clinicId === null && ctx.clinicId !== null)
      || target.assignments.some((a) => a.role.permissions.some((rp) => !actor.permissions.has(rp.permission.code) && !attendance.includes(rp.permission.code)));
    if (stronger) {
      await this.audit.recordSafely({ action: AuditAction.EscalationBlocked, entity: 'User', entityId: targetId, userId: actor.user.id, clinicId: ctx.clinicId, branchId: ctx.branchId, meta, summary: { reason: 'password_reset_stronger_account' } });
      throw new ForbiddenException('No puede restablecer la contraseña de una cuenta con más permisos que los suyos');
    }

    const generated = !dto.password;
    const password = dto.password ?? generatePassword();
    const passwordHash = await hashPassword(password);
    const now = new Date();
    await this.db.$transaction(async (tx) => {
      await tx.user.update({ where: { id: targetId }, data: { passwordHash, failedLoginAttempts: 0, lockedUntil: null } });
      const sessionsRevoked = await this.sessions.revokeAllForUser(targetId, 'PASSWORD_RESET', tx);
      await this.sessions.invalidateReauthProofs(targetId, tx);
      await tx.passwordRecovery.updateMany({
        where: { userId: targetId, status: 'PENDING' },
        data: { status: 'REVOKED', pendingKey: null, revokedAt: now, revokedReason: 'admin_reset' },
      });
      await this.audit.record(
        { action: AuditAction.UserPasswordReset, entity: 'User', entityId: targetId, userId: actor.user.id, clinicId: ctx.clinicId, branchId: ctx.branchId, meta, summary: { passwordGenerated: generated, sessionsRevoked } },
        tx,
      );
    });
    return { ok: true, ...(generated ? { password } : {}) };
  }
}
