import { randomBytes, randomInt } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
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
import { AppConfig } from '../config/app-config.js';
import { ApiworkingClient, ApiworkingError, clip } from '../apiworking/apiworking.client.js';
import { ApiworkingSessionStore } from '../apiworking/apiworking-session.store.js';
import { pendingExternalId } from '../apiworking/apiworking-auth.service.js';

/** Sin caracteres que se confunden al dictarlos o copiarlos a mano (0/O, 1/l/I). */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const GROUPS = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnpqrstuvwxyz', '23456789'];

/** Contraseña aleatoria de 10 caracteres (al menos una mayúscula, una minúscula y un número). */
export function generatePassword(length = 10): string {
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
    private readonly config: AppConfig,
    private readonly client: ApiworkingClient,
    private readonly externalSessions: ApiworkingSessionStore,
  ) {}

  async create(
    actor: AuthPrincipal,
    dto: { email: string; firstName: string; lastName: string; roleCode: string; clinicId?: string; branchId?: string; password?: string; username?: string },
    meta: RequestMeta,
  ) {
    if (this.config.authMode === 'apiworking') return this.createInApiworking(actor, dto, meta);
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

  /**
   * Clínicas con Apiworking: la cuenta se crea en Apiworking (POST /api/User, con la sesión de quien la crea) y aquí queda el usuario
   * local con su rol, vinculado por su usuario hasta que ingrese por primera vez. La contraseña es la de Apiworking: se devuelve una
   * sola vez si la generó el sistema y nunca se guarda (ni su hash) en este sistema.
   */
  private async createInApiworking(
    actor: AuthPrincipal,
    dto: { email: string; firstName: string; lastName: string; roleCode: string; clinicId?: string; branchId?: string; password?: string; username?: string },
    meta: RequestMeta,
  ) {
    if (!dto.username) throw new BadRequestException('Indique el usuario de Apiworking');
    const grant = await this.assignments.validateGrant(actor, { roleCode: dto.roleCode, clinicId: dto.clinicId, branchId: dto.branchId });
    if (RETIRED_ROLE_CODES.includes(grant.roleCode)) throw new ForbiddenException('Ese rol ya no se usa: elija Administrador, Cajero u Odontólogo');
    const tenant = this.config.apiworking.expectedDatabase;
    if (!tenant) throw new BadRequestException('Apiworking no está configurado en esta instalación');
    const session = this.externalSessions.get(actor.sessionId);
    if (!session) throw new ConflictException({ message: 'Vuelva a iniciar sesión con su cuenta de Apiworking para crear usuarios', code: 'APIWORKING_SESSION_REQUIRED' });
    const username = dto.username.trim();
    const taken = await this.db.externalIdentity.findFirst({ where: { provider: 'APIWORKING', tenant, externalUsername: username }, select: { id: true } });
    if (taken) throw new ConflictException({ message: 'Ese usuario de Apiworking ya existe en este sistema: asígnele el rol desde la lista', code: 'USERNAME_TAKEN' });

    const generated = !dto.password;
    const password = dto.password ?? generatePassword();
    let data: unknown;
    try {
      data = await this.client.call('createUser', { token: session.token, body: { apellidos: dto.lastName.trim(), nombres: dto.firstName.trim(), usuario: username, email: dto.email.trim().toLowerCase(), clave: password } });
    } catch (error) {
      if (error instanceof ApiworkingError && (error.kind === 'UNKNOWN_RESULT' || error.kind === 'BAD_RESPONSE')) {
        throw new ConflictException({ message: 'No se pudo confirmar si Apiworking creó el usuario. Revíselo en Apiworking antes de intentarlo otra vez; si existe, la persona puede ingresar y usted le asigna el rol.', code: 'APIWORKING_UNCONFIRMED' });
      }
      if (error instanceof ApiworkingError) throw new UnprocessableEntityException({ message: clip(error.message) || 'Apiworking rechazó el usuario', code: 'APIWORKING_REJECTED' });
      throw error;
    }
    // La guía no tiene ejemplo de respuesta: si trae el id del usuario se usa; si no, se vincula en su primer ingreso por el usuario.
    const record = Array.isArray(data) ? data[0] : data;
    const r = typeof record === 'object' && record !== null ? (record as Record<string, unknown>) : {};
    const rawId = ['id_usuario', 'idUsuario', 'id'].map((k) => r[k]).find((v) => (typeof v === 'string' && v.trim()) || typeof v === 'number');
    const externalUserId = rawId !== undefined ? String(rawId).trim().slice(0, 40) : pendingExternalId(username);
    // Sin contraseña local utilizable: se ingresa por Apiworking.
    const unusable = await hashPassword(randomBytes(32).toString('base64'));
    const user = await this.db.$transaction(async (tx) => {
      const u = await tx.user.create({
        data: { email: `aw-${externalUserId.replace(/[^A-Za-z0-9._-]/g, '-')}@apiworking.invalid`, firstName: dto.firstName.trim(), lastName: dto.lastName.trim(), passwordHash: unusable },
        select: { id: true, email: true, firstName: true, lastName: true, status: true, createdAt: true },
      });
      await tx.externalIdentity.create({ data: { userId: u.id, provider: 'APIWORKING', tenant, externalUserId, externalUsername: username, lastLoginAt: new Date(0) } });
      await this.assignments.persist(actor.user.id, u.id, grant, meta, tx);
      await this.audit.record(
        { action: AuditAction.UserCreated, entity: 'User', entityId: u.id, userId: actor.user.id, clinicId: grant.clinicId, branchId: grant.branchId, meta, summary: { via: 'apiworking', roleCode: grant.roleCode, passwordGenerated: generated, linked: rawId !== undefined } },
        tx,
      );
      return u;
    });
    return { user, username, ...(generated ? { password } : {}) };
  }

  /**
   * Da acceso con Apiworking a un usuario que hoy ingresa con correo: crea su cuenta en Apiworking (POST /api/User) y la enlaza a la
   * MISMA persona (conserva citas, atenciones y roles). Mismas reglas de alcance y anti-escalada que restablecer la contraseña.
   */
  async grantApiworkingAccess(actor: AuthPrincipal, targetId: string, dto: { username: string; password: string; email?: string }, meta: RequestMeta) {
    if (this.config.authMode !== 'apiworking') throw new BadRequestException('Esta clínica no usa Apiworking');
    const tenant = this.config.apiworking.expectedDatabase;
    if (!tenant) throw new BadRequestException('Apiworking no está configurado en esta instalación');
    const target = await this.checkTarget(actor, targetId, meta);
    if (target.externalIdentity) throw new ConflictException({ message: 'Ese usuario ya ingresa con Apiworking', code: 'ALREADY_LINKED' });
    const user = await this.db.user.findUniqueOrThrow({ where: { id: targetId }, select: { email: true, firstName: true, lastName: true } });
    const email = (dto.email ?? user.email).trim().toLowerCase();
    if (email.endsWith('.invalid')) throw new BadRequestException('Indique un correo para la cuenta de Apiworking');
    const username = dto.username.trim();
    const taken = await this.db.externalIdentity.findFirst({ where: { provider: 'APIWORKING', tenant, externalUsername: username }, select: { id: true } });
    if (taken) throw new ConflictException({ message: 'Ese usuario de Apiworking ya existe en este sistema', code: 'USERNAME_TAKEN' });
    const session = this.externalSessions.get(actor.sessionId);
    if (!session) throw new ConflictException({ message: 'Vuelva a iniciar sesión con su cuenta de Apiworking', code: 'APIWORKING_SESSION_REQUIRED' });
    let data: unknown;
    try {
      data = await this.client.call('createUser', { token: session.token, body: { apellidos: user.lastName, nombres: user.firstName, usuario: username, email, clave: dto.password } });
    } catch (error) {
      if (error instanceof ApiworkingError && (error.kind === 'UNKNOWN_RESULT' || error.kind === 'BAD_RESPONSE')) {
        throw new ConflictException({ message: 'No se pudo confirmar si Apiworking creó el usuario. Revíselo en Apiworking antes de intentarlo otra vez.', code: 'APIWORKING_UNCONFIRMED' });
      }
      if (error instanceof ApiworkingError) throw new UnprocessableEntityException({ message: clip(error.message) || 'Apiworking rechazó el usuario', code: 'APIWORKING_REJECTED' });
      throw error;
    }
    const record = Array.isArray(data) ? data[0] : data;
    const r = typeof record === 'object' && record !== null ? (record as Record<string, unknown>) : {};
    const rawId = ['id_usuario', 'idUsuario', 'id'].map((k) => r[k]).find((v) => (typeof v === 'string' && v.trim()) || typeof v === 'number');
    const externalUserId = rawId !== undefined ? String(rawId).trim().slice(0, 40) : pendingExternalId(username);
    await this.db.$transaction(async (tx) => {
      await tx.externalIdentity.create({ data: { userId: targetId, provider: 'APIWORKING', tenant, externalUserId, externalUsername: username, lastLoginAt: new Date(0) } });
      await this.audit.record({ action: 'USER_APIWORKING_ACCESS_GRANTED', entity: 'User', entityId: targetId, userId: actor.user.id, clinicId: actor.context!.clinicId, branchId: actor.context!.branchId, meta, summary: { linked: rawId !== undefined } }, tx);
    });
    return { ok: true, username };
  }

  /** Alcance y anti-escalada para actuar sobre otra cuenta (restablecer contraseña o dar acceso). */
  private async checkTarget(actor: AuthPrincipal, targetId: string, meta: RequestMeta) {
    if (targetId === actor.user.id) throw new ForbiddenException('No puede hacerlo sobre su propia cuenta');
    const ctx = actor.context!;
    const target = await this.db.user.findUnique({
      where: { id: targetId },
      select: {
        id: true,
        externalIdentity: { select: { id: true } },
        assignments: { where: { status: 'ACTIVE' }, select: { clinicId: true, branchId: true, role: { select: { code: true, permissions: { select: { permission: { select: { code: true } } } } } } } },
      },
    });
    if (!target) throw new NotFoundException('Usuario no encontrado');
    const inScope = (a: { clinicId: string | null; branchId: string | null }) =>
      ctx.clinicId === null || (a.clinicId === ctx.clinicId && (!ctx.branchId || a.branchId === null || a.branchId === ctx.branchId));
    if (ctx.clinicId !== null && !target.assignments.some(inScope)) throw new NotFoundException('Usuario no encontrado');
    const attendance = CARE_ATTENDANCE_PERMISSIONS as readonly string[];
    const stronger = target.assignments.some((a) => a.clinicId === null && ctx.clinicId !== null)
      || target.assignments.some((a) => a.role.permissions.some((rp) => !actor.permissions.has(rp.permission.code) && !attendance.includes(rp.permission.code)));
    if (stronger) {
      await this.audit.recordSafely({ action: AuditAction.EscalationBlocked, entity: 'User', entityId: targetId, userId: actor.user.id, clinicId: ctx.clinicId, branchId: ctx.branchId, meta, summary: { reason: 'stronger_account' } });
      throw new ForbiddenException('No puede actuar sobre una cuenta con más permisos que los suyos');
    }
    return target;
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
