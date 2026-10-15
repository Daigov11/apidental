import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { AuditAction, AuditService } from '../audit/audit.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { LoginAttemptsService } from '../auth/login-attempts.service.js';
import { ReauthService } from '../auth/reauth.service.js';
import { hashPassword, verifyPassword } from '../common/utils/password.js';
import { passwordPolicyErrors } from '../common/utils/password-policy.js';
import type { RequestMeta } from '../common/utils/request-meta.js';
import { generateToken, hashToken, looksLikeToken } from '../common/utils/secret-token.js';
import { AppConfig } from '../config/app-config.js';
import { maskEmail } from '../patients/util/mask.js';
import type { DbTx, PrismaDb } from '../prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';
import { ProvisioningService } from '../provisioning/provisioning.service.js';
import { assignmentKey } from '../users/assignment-key.js';
import { AssignmentsService } from '../users/assignments.service.js';
import type { AcceptInvitationDto, CreateInvitationDto, ListInvitationsQuery } from './dto/invitation.dto.js';
import { INVITATION_DELIVERY, type InvitationDelivery } from './delivery/invitation-delivery.js';

export const INVITATION_PREFIX = 'inv';
/** Mensaje ÚNICO para cualquier fallo de token (inexistente, vencido, revocado, usado, manipulado). */
const INVALID_INVITATION = 'Invitación inválida o vencida';
const PLATFORM_MANAGED_ROLES = ['PLATFORM_ADMIN', 'CLINIC_ADMIN'];

class InvitationUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

const isUniqueViolation = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';

type InvitationRow = {
  id: string;
  email: string;
  roleId: string;
  clinicId: string | null;
  branchId: string | null;
  status: string;
  expiresAt: Date;
  createdById: string;
  createdAt: Date;
  issuedByPlatform: boolean;
  deliveryStatus: string;
  deliveryAttempts: number;
  lastDeliveryAt: Date | null;
  lastDeliveryError: string | null;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  revokeReason: string | null;
  provisioningRecordId: string | null;
  role: { code: string; name: string };
};

/**
 * Invitaciones de un solo uso. Garantías:
 *  - El token (256 bits) solo viaja por el canal de entrega; en la base solo existe su SHA-256.
 *  - La persona invitada define su propia contraseña; ni quien invita ni la plataforma la conocen.
 *    Una invitación NUNCA cambia la contraseña de una cuenta que ya existe.
 *  - Ninguna respuesta depende de si el correo ya tiene cuenta (para quien invita); todo fallo de
 *    token responde igual.
 *  - La plataforma solo invita al PRIMER administrador de una clínica sin administrador y nunca
 *    designa al Director Clínico.
 *  - El Director Clínico exige registro formal de aprovisionamiento (el primero) o un Director vigente
 *    (los siguientes), y reautenticación.
 */
@Injectable()
export class InvitationsService {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaDb,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
    private readonly assignments: AssignmentsService,
    private readonly reauth: ReauthService,
    private readonly provisioning: ProvisioningService,
    private readonly attempts: LoginAttemptsService,
    @Inject(INVITATION_DELIVERY) private readonly delivery: InvitationDelivery,
  ) {}

  // ===================================================================== crear

  async create(actor: AuthPrincipal, dto: CreateInvitationDto, meta: RequestMeta) {
    if (this.delivery.mode === 'disabled') {
      // Falla cerrada: sin canal no se crea nada (el token se perdería).
      throw new ServiceUnavailableException('No hay un canal de entrega de invitaciones configurado');
    }
    await this.expireDue();
    const ctx = actor.context!;
    const actorIsPlatform = ctx.clinicId === null;
    const isDirector = dto.roleCode === 'CLINICAL_DIRECTOR';

    // --- permiso según el rol invitado (el Director tiene el suyo) ---
    if (isDirector) {
      if (actorIsPlatform) throw new ForbiddenException('La plataforma no designa al Director Clínico');
    } else if (!actor.permissions.has('invitation:manage')) {
      throw new ForbiddenException('No tiene permisos para invitar');
    }

    // --- destino válido y dentro del alcance (anti-escalada, clínica/sede activas) ---
    const grant = await this.assignments.validateGrant(
      actor,
      { roleCode: dto.roleCode, clinicId: dto.clinicId, branchId: dto.branchId },
      this.db,
      { allowDirector: isDirector, platformMayInviteClinicAdmin: true },
    );

    let provisioningRecordId: string | null = null;
    if (actorIsPlatform && grant.roleCode === 'CLINIC_ADMIN') {
      if (grant.branchId) throw new BadRequestException('El administrador de clínica se invita para toda la clínica');
      // Ventana de aprovisionamiento: solo si la clínica NO tiene administrador activo. Después, la
      // plataforma ya no puede incorporar administradores a esa clínica.
      if ((await this.activeClinicAdminCount(this.db, grant.clinicId!)) > 0) {
        throw new ConflictException({
          message: 'La clínica ya tiene administrador; los siguientes los invita su propia administración',
          code: 'CLINIC_HAS_ADMIN',
        });
      }
    }
    if (isDirector) provisioningRecordId = await this.prepareDirectorInvitation(actor, dto, grant.clinicId!);

    const token = generateToken(INVITATION_PREFIX);
    const expiresAt = new Date(Date.now() + this.config.invitations.ttlHours * 3_600_000);
    let row: InvitationRow;
    try {
      row = await this.db.$transaction(async (tx) => {
        const created = await tx.invitation.create({
          data: {
            email: dto.email,
            roleId: grant.roleId,
            clinicId: grant.clinicId,
            branchId: grant.branchId,
            tokenHash: hashToken(token),
            pendingKey: [dto.email, grant.roleId, grant.clinicId ?? '*', grant.branchId ?? '*'].join('|'),
            expiresAt,
            createdById: actor.user.id,
            issuedByPlatform: actorIsPlatform,
            provisioningRecordId,
          },
          include: { role: { select: { code: true, name: true } } },
        });
        if (isDirector) {
          await this.reauth.consume(
            { userId: actor.user.id, sessionId: actor.sessionId },
            dto.reauthToken,
            'AUTHORIZE_DIRECTOR_PROVISIONING',
            grant.clinicId,
            meta,
            tx,
          );
        }
        await this.audit.record(
          {
            action: AuditAction.InvitationCreated,
            entity: 'Invitation',
            entityId: created.id,
            userId: actor.user.id,
            clinicId: grant.clinicId,
            branchId: grant.branchId,
            meta,
            summary: {
              roleCode: grant.roleCode,
              recipient: maskEmail(dto.email),
              expiresAt: expiresAt.toISOString(),
              provisioningRecordId,
              issuedByPlatform: actorIsPlatform,
            },
          },
          tx,
        );
        return created;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('Ya existe una invitación pendiente para ese destinatario y rol');
      }
      throw error;
    }

    const outcome = await this.dispatch(row, token, meta, actor.user.id, 'created');
    return { ...this.view(await this.reload(row.id)), ...(outcome.devLink ? { devAcceptUrl: outcome.devLink } : {}) };
  }

  /** Reglas del Director: primer Director (registro formal) o siguientes (un Director vigente). */
  private async prepareDirectorInvitation(actor: AuthPrincipal, dto: CreateInvitationDto, clinicId: string): Promise<string | null> {
    if (dto.branchId) throw new BadRequestException('El Director Clínico se designa para toda la clínica');
    if (!dto.reauthToken) throw new BadRequestException('Designar al Director Clínico exige una prueba de reautenticación (reauthToken)');

    const directors = await this.provisioning.activeDirectorCount(this.db, clinicId);
    if (directors === 0) {
      if (!actor.permissions.has('provisioning:record')) {
        throw new ForbiddenException('Solo el administrador de la clínica designa al primer Director Clínico');
      }
      if (!dto.provisioningRecordId) {
        throw new BadRequestException('El primer Director Clínico exige un registro formal de aprovisionamiento (provisioningRecordId)');
      }
      await this.provisioning.expireDue();
      await this.provisioning.assertUsable(this.db, clinicId, dto.provisioningRecordId, dto.email);
      const pendingDirectors = await this.db.invitation.count({
        where: { clinicId, status: 'PENDING', role: { code: 'CLINICAL_DIRECTOR' } },
      });
      if (pendingDirectors > 0) {
        throw new ConflictException('Ya hay una invitación de Director Clínico pendiente; revóquela antes de crear otra');
      }
      return dto.provisioningRecordId;
    }
    if (!actor.permissions.has('director:manage')) {
      throw new ForbiddenException('Solo un Director Clínico vigente puede designar a otro Director');
    }
    if (dto.provisioningRecordId) {
      throw new BadRequestException('Los Directores siguientes no usan registro de aprovisionamiento');
    }
    return null;
  }

  // ======================================================== listar / revocar / reenviar

  async list(actor: AuthPrincipal, q: ListInvitationsQuery) {
    await this.expireDue();
    const ctx = actor.context!;
    const where =
      ctx.clinicId === null
        ? { role: { code: { in: PLATFORM_MANAGED_ROLES } } } // la plataforma no ve invitaciones de Director ni de personal
        : { clinicId: ctx.clinicId, ...(ctx.branchId ? { branchId: ctx.branchId } : {}) };
    const rows = await this.db.invitation.findMany({
      where: { ...where, ...(q.status ? { status: q.status } : {}) },
      include: { role: { select: { code: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      take: q.limit,
      skip: q.offset,
    });
    return rows.map((r) => this.view(r));
  }

  async revoke(actor: AuthPrincipal, id: string, reason: string, meta: RequestMeta) {
    const inv = await this.manageable(actor, id);
    if (inv.status !== 'PENDING') throw new ConflictException('Solo se puede revocar una invitación pendiente');
    await this.db.$transaction(async (tx) => {
      const res = await tx.invitation.updateMany({
        where: { id, status: 'PENDING' },
        data: { status: 'REVOKED', pendingKey: null, revokedAt: new Date(), revokedById: actor.user.id, revokeReason: reason },
      });
      if (res.count !== 1) throw new ConflictException('Solo se puede revocar una invitación pendiente');
      await this.audit.record(
        {
          action: AuditAction.InvitationRevoked,
          entity: 'Invitation',
          entityId: id,
          userId: actor.user.id,
          clinicId: inv.clinicId,
          branchId: inv.branchId,
          meta,
          summary: { roleCode: inv.role.code, reason },
        },
        tx,
      );
    });
    return this.view(await this.reload(id));
  }

  /**
   * Como el token no se guarda, reenviar = generar un token NUEVO: el enlace anterior deja de valer.
   */
  async resend(actor: AuthPrincipal, id: string, meta: RequestMeta) {
    if (this.delivery.mode === 'disabled') throw new ServiceUnavailableException('No hay un canal de entrega de invitaciones configurado');
    const inv = await this.manageable(actor, id);
    if (inv.status !== 'PENDING' || inv.expiresAt <= new Date()) {
      throw new ConflictException('Solo se puede reenviar una invitación pendiente y vigente');
    }
    const token = generateToken(INVITATION_PREFIX);
    await this.db.$transaction(async (tx) => {
      const res = await tx.invitation.updateMany({
        where: { id, status: 'PENDING' },
        data: { tokenHash: hashToken(token), tokenRotatedAt: new Date() },
      });
      if (res.count !== 1) throw new ConflictException('Solo se puede reenviar una invitación pendiente y vigente');
      await this.audit.record(
        { action: AuditAction.InvitationResent, entity: 'Invitation', entityId: id, userId: actor.user.id, clinicId: inv.clinicId, branchId: inv.branchId, meta, summary: { roleCode: inv.role.code, tokenRotated: true } },
        tx,
      );
    });
    const outcome = await this.dispatch(inv, token, meta, actor.user.id, 'resent');
    return { ...this.view(await this.reload(id)), ...(outcome.devLink ? { devAcceptUrl: outcome.devLink } : {}) };
  }

  /** Invitación dentro del alcance del solicitante y con su permiso (404 uniforme si no). */
  private async manageable(actor: AuthPrincipal, id: string) {
    const ctx = actor.context!;
    const inv = await this.db.invitation.findUnique({ where: { id }, include: { role: { select: { code: true, name: true } } } });
    const inScope =
      inv &&
      (ctx.clinicId === null
        ? PLATFORM_MANAGED_ROLES.includes(inv.role.code)
        : inv.clinicId === ctx.clinicId && (!ctx.branchId || inv.branchId === ctx.branchId));
    if (!inv || !inScope) throw new NotFoundException('Invitación no encontrada');

    const allowed =
      inv.role.code === 'CLINICAL_DIRECTOR'
        ? actor.permissions.has('director:manage') || actor.permissions.has('provisioning:record')
        : actor.permissions.has('invitation:manage');
    if (!allowed) throw new ForbiddenException('No tiene permisos para esta invitación');
    return inv;
  }

  // ========================================================================= público

  /** Datos mínimos para mostrar en la pantalla de aceptación. Todo fallo responde igual. */
  async preview(token: unknown) {
    const inv = await this.findByToken(token);
    if (!inv || inv.status !== 'PENDING') throw new NotFoundException(INVALID_INVITATION);
    if (inv.expiresAt <= new Date()) {
      await this.markExpired(inv.id, inv.clinicId, inv.branchId);
      throw new NotFoundException(INVALID_INVITATION);
    }
    const user = await this.db.user.findUnique({ where: { email: inv.email }, select: { id: true } });
    return {
      clinicName: inv.clinic?.name ?? null,
      roleName: inv.role.name,
      expiresAt: inv.expiresAt,
      emailHint: maskEmail(inv.email),
      // Solo lo ve quien posee el token (el destinatario): indica si debe crear contraseña o usar la actual.
      requiresExistingPassword: Boolean(user),
    };
  }

  async accept(dto: AcceptInvitationDto, meta: RequestMeta) {
    const inv = await this.findByToken(dto.token);
    if (!inv) throw new NotFoundException(INVALID_INVITATION);
    const now = new Date();
    if (inv.status !== 'PENDING') {
      await this.rejected(inv, `status_${inv.status.toLowerCase()}`, meta);
      throw new NotFoundException(INVALID_INVITATION);
    }
    if (inv.expiresAt <= now) {
      await this.markExpired(inv.id, inv.clinicId, inv.branchId);
      throw new NotFoundException(INVALID_INVITATION);
    }

    const existing = await this.db.user.findUnique({ where: { email: inv.email }, omit: { passwordHash: false } });
    let newPasswordHash: string | null = null;
    if (existing) {
      // Cuenta existente: se demuestra con SU contraseña; la invitación jamás la reemplaza.
      if (existing.status !== 'ACTIVE') {
        await this.rejected(inv, 'user_disabled', meta);
        throw new NotFoundException(INVALID_INVITATION);
      }
      const ok = !this.attempts.isLocked(existing) && (await verifyPassword(existing.passwordHash, dto.password));
      if (!ok) {
        await this.attempts.registerFailure(existing.id, 'invitation_bad_password', meta, AuditAction.InvitationRejected);
        throw new UnauthorizedException('No se pudo aceptar la invitación');
      }
    } else {
      const errors: string[] = passwordPolicyErrors(dto.password, { email: inv.email });
      if (!dto.firstName) errors.push('firstName es obligatorio para crear la cuenta');
      if (!dto.lastName) errors.push('lastName es obligatorio para crear la cuenta');
      if (errors.length > 0) throw new BadRequestException(errors);
      newPasswordHash = await hashPassword(dto.password);
    }

    try {
      // READ COMMITTED es imprescindible: con REPEATABLE READ (por defecto) la instantánea se fija en la
      // primera lectura, ANTES de obtener el bloqueo de la clínica, y el conteo de administradores/Directores
      // no vería a quien aceptó justo antes (dos aceptaciones simultáneas prosperarían ambas).
      await this.db.$transaction(
        async (tx) => this.acceptInTransaction(tx, inv.id, existing?.id ?? null, newPasswordHash, dto, meta, now),
        { isolationLevel: 'ReadCommitted' },
      );
    } catch (error) {
      if (error instanceof InvitationUnavailableError) {
        await this.rejected(inv, error.reason, meta);
        throw new NotFoundException(INVALID_INVITATION);
      }
      throw error;
    }
    return { accepted: true, role: { code: inv.role.code, name: inv.role.name }, clinic: inv.clinic ? { name: inv.clinic.name } : null };
  }

  private async acceptInTransaction(
    tx: DbTx,
    invitationId: string,
    existingUserId: string | null,
    newPasswordHash: string | null,
    dto: AcceptInvitationDto,
    meta: RequestMeta,
    now: Date,
  ): Promise<void> {
    // Bloqueo de la invitación: dos aceptaciones simultáneas se serializan y la segunda la ve usada.
    const locked = await tx.$queryRaw<{ status: string; expires_at: Date }[]>`
      SELECT status, expires_at FROM invitations WHERE id = ${invitationId} FOR UPDATE`;
    if (!locked[0] || locked[0].status !== 'PENDING' || locked[0].expires_at <= now) throw new InvitationUnavailableError('unavailable');

    const inv = await tx.invitation.findUniqueOrThrow({ where: { id: invitationId }, include: { role: true } });
    // Se serializa por clínica para comprobar "no tiene administrador/Director" sin carreras.
    if (inv.clinicId) await tx.$queryRaw`SELECT id FROM clinics WHERE id = ${inv.clinicId} FOR UPDATE`;
    await this.revalidateTarget(tx, inv);

    let userId = existingUserId;
    let created = false;
    if (!userId) {
      try {
        const user = await tx.user.create({
          data: { email: inv.email, passwordHash: newPasswordHash!, firstName: dto.firstName!, lastName: dto.lastName! },
          select: { id: true },
        });
        userId = user.id;
        created = true;
      } catch (error) {
        if (isUniqueViolation(error)) throw new InvitationUnavailableError('account_created_meanwhile');
        throw error;
      }
    }

    const grant = { roleId: inv.roleId, clinicId: inv.clinicId, branchId: inv.branchId };
    const already = await tx.userAssignment.findUnique({ where: { assignmentKey: assignmentKey(userId, grant) } });
    if (!already || already.status !== 'ACTIVE') {
      await this.assignments.persist(userId, userId, { ...grant, roleCode: inv.role.code }, meta, tx);
    }

    await tx.invitation.update({
      where: { id: invitationId },
      data: { status: 'ACCEPTED', pendingKey: null, acceptedAt: now, acceptedUserId: userId },
    });
    await this.audit.record(
      {
        action: AuditAction.InvitationAccepted,
        entity: 'Invitation',
        entityId: invitationId,
        userId,
        clinicId: inv.clinicId,
        branchId: inv.branchId,
        meta,
        summary: { roleCode: inv.role.code, newAccount: created },
      },
      tx,
    );
    if (created) {
      await this.audit.record(
        { action: AuditAction.UserCreated, entity: 'User', entityId: userId, userId, clinicId: inv.clinicId, meta, summary: { via: 'invitation', email: maskEmail(inv.email) } },
        tx,
      );
    }
    if (inv.role.code === 'CLINICAL_DIRECTOR') {
      if (inv.provisioningRecordId) await this.provisioning.consume(tx, inv.provisioningRecordId, invitationId, inv.clinicId!, meta, userId);
      await this.audit.record(
        {
          action: AuditAction.DirectorRoleGranted,
          entity: 'UserAssignment',
          entityId: userId,
          userId,
          clinicId: inv.clinicId,
          meta,
          summary: { invitationId, grantedBy: inv.createdById, provisioningRecordId: inv.provisioningRecordId },
        },
        tx,
      );
    }
  }

  /** La situación pudo cambiar entre la invitación y su aceptación: se vuelve a comprobar todo lo relevante. */
  private async revalidateTarget(
    tx: DbTx,
    inv: { clinicId: string | null; branchId: string | null; createdById: string; issuedByPlatform: boolean; provisioningRecordId: string | null; email: string; role: { code: string; scope: string } },
  ): Promise<void> {
    if (inv.clinicId) {
      const clinic = await tx.clinic.findUnique({ where: { id: inv.clinicId }, select: { status: true } });
      if (!clinic || clinic.status !== 'ACTIVE') throw new InvitationUnavailableError('clinic_inactive');
      if (inv.branchId) {
        const branch = await tx.branch.findFirst({ where: { id: inv.branchId, clinicId: inv.clinicId }, select: { status: true } });
        if (!branch || branch.status !== 'ACTIVE') throw new InvitationUnavailableError('branch_inactive');
      }
    }
    // Quien invitó debe seguir teniendo autoridad para hacerlo.
    const creator = await tx.user.findUnique({ where: { id: inv.createdById }, select: { status: true } });
    if (!creator || creator.status !== 'ACTIVE') throw new InvitationUnavailableError('inviter_inactive');
    const creatorAuthorities = await tx.userAssignment.count({
      where: inv.issuedByPlatform || inv.clinicId === null
        ? { userId: inv.createdById, status: 'ACTIVE', clinicId: null, role: { code: 'PLATFORM_ADMIN' } }
        : { userId: inv.createdById, status: 'ACTIVE', clinicId: inv.clinicId, role: { code: { in: ['CLINIC_ADMIN', 'CLINICAL_DIRECTOR'] } } },
    });
    if (creatorAuthorities === 0) throw new InvitationUnavailableError('inviter_lost_authority');

    if (inv.role.code === 'CLINIC_ADMIN' && inv.issuedByPlatform) {
      // La plataforma solo aprovisiona a una clínica SIN administrador.
      if ((await this.activeClinicAdminCount(tx, inv.clinicId!)) > 0) throw new InvitationUnavailableError('clinic_has_admin');
    }
    if (inv.role.code === 'CLINICAL_DIRECTOR') {
      if (inv.provisioningRecordId) {
        const record = await tx.provisioningRecord.findUnique({ where: { id: inv.provisioningRecordId } });
        if (!record || record.status !== 'ACTIVE' || record.expiresAt <= new Date() || record.designeeEmail !== inv.email) {
          throw new InvitationUnavailableError('provisioning_not_usable');
        }
        if ((await this.provisioning.activeDirectorCount(tx, inv.clinicId!)) > 0) throw new InvitationUnavailableError('director_already_designated');
      } else {
        const creatorIsDirector = await tx.userAssignment.count({
          where: { userId: inv.createdById, status: 'ACTIVE', clinicId: inv.clinicId, role: { code: 'CLINICAL_DIRECTOR' } },
        });
        if (creatorIsDirector === 0) throw new InvitationUnavailableError('inviter_not_director');
      }
    }
  }

  // ======================================================================= internos

  private async findByToken(token: unknown) {
    if (!looksLikeToken(token, INVITATION_PREFIX)) return null;
    return this.db.invitation.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { role: true, clinic: { select: { name: true } } },
    });
  }

  private activeClinicAdminCount(db: DbTx | PrismaDb, clinicId: string): Promise<number> {
    return db.userAssignment.count({
      where: { clinicId, branchId: null, status: 'ACTIVE', role: { code: 'CLINIC_ADMIN' }, user: { status: 'ACTIVE' } },
    });
  }

  private async rejected(inv: { id: string; clinicId: string | null; branchId: string | null }, reason: string, meta: RequestMeta) {
    await this.audit.recordSafely({
      action: AuditAction.InvitationRejected,
      entity: 'Invitation',
      entityId: inv.id,
      clinicId: inv.clinicId,
      branchId: inv.branchId,
      meta,
      summary: { reason },
    });
  }

  /** PENDING -> EXPIRED una sola vez (condicional) y auditado una sola vez. */
  private async markExpired(id: string, clinicId: string | null, branchId: string | null): Promise<void> {
    const res = await this.db.invitation.updateMany({
      where: { id, status: 'PENDING', expiresAt: { lte: new Date() } },
      data: { status: 'EXPIRED', pendingKey: null, expiredAt: new Date() },
    });
    if (res.count === 1) {
      await this.audit.recordSafely({ action: AuditAction.InvitationExpired, entity: 'Invitation', entityId: id, clinicId, branchId });
    }
  }

  /** Vence en lote las invitaciones cuyo plazo terminó. Devuelve cuántas procesó. */
  async expireDue(): Promise<number> {
    const due = await this.db.invitation.findMany({
      where: { status: 'PENDING', expiresAt: { lte: new Date() } },
      select: { id: true, clinicId: true, branchId: true },
      take: 200,
    });
    for (const inv of due) await this.markExpired(inv.id, inv.clinicId, inv.branchId);
    return due.length;
  }

  /** Entrega por el canal configurado y registra el resultado (sin guardar jamás el enlace ni el token). */
  private async dispatch(
    inv: { id: string; email: string; roleId: string; clinicId: string | null; branchId: string | null; expiresAt: Date; deliveryAttempts: number },
    token: string,
    meta: RequestMeta,
    actorId: string,
    kind: 'created' | 'resent',
  ) {
    const [role, clinic] = await Promise.all([
      this.db.role.findUniqueOrThrow({ where: { id: inv.roleId }, select: { name: true } }),
      inv.clinicId ? this.db.clinic.findUnique({ where: { id: inv.clinicId }, select: { name: true } }) : null,
    ]);
    const outcome = await this.delivery.deliver({
      type: 'invitation',
      invitationId: inv.id,
      toEmail: inv.email,
      acceptUrl: `${this.config.invitations.acceptBaseUrl}#token=${token}`,
      clinicName: clinic?.name ?? null,
      roleName: role.name,
      expiresAt: inv.expiresAt,
    });
    const now = new Date();
    if (outcome.ok) {
      await this.db.invitation.update({
        where: { id: inv.id },
        data: { deliveryStatus: 'SENT', deliveryAttempts: { increment: 1 }, lastDeliveryAt: now, lastDeliveryError: null },
      });
      await this.audit.recordSafely({
        action: AuditAction.InvitationSent,
        entity: 'Invitation',
        entityId: inv.id,
        userId: actorId,
        clinicId: inv.clinicId,
        branchId: inv.branchId,
        meta,
        summary: { channel: this.delivery.mode, kind },
      });
    } else {
      await this.db.invitation.update({
        where: { id: inv.id },
        data: { deliveryStatus: 'FAILED', deliveryAttempts: { increment: 1 }, lastDeliveryAt: now, lastDeliveryError: outcome.reason.slice(0, 120) },
      });
      await this.audit.recordSafely({
        action: AuditAction.InvitationDeliveryFailed,
        entity: 'Invitation',
        entityId: inv.id,
        userId: actorId,
        clinicId: inv.clinicId,
        branchId: inv.branchId,
        meta,
        summary: { channel: this.delivery.mode, kind, reason: outcome.reason },
      });
    }
    return outcome.ok ? outcome : { ok: false as const, reason: outcome.reason, devLink: undefined };
  }

  private reload(id: string) {
    return this.db.invitation.findUniqueOrThrow({ where: { id }, include: { role: { select: { code: true, name: true } } } });
  }

  /** Vista de una invitación. NUNCA incluye el token ni su hash. */
  private view(r: InvitationRow) {
    return {
      id: r.id,
      email: r.email,
      role: { code: r.role.code, name: r.role.name },
      clinicId: r.clinicId,
      branchId: r.branchId,
      status: r.status,
      expiresAt: r.expiresAt,
      createdAt: r.createdAt,
      createdById: r.createdById,
      delivery: {
        status: r.deliveryStatus,
        attempts: r.deliveryAttempts,
        lastAttemptAt: r.lastDeliveryAt,
        lastError: r.lastDeliveryError,
      },
      acceptedAt: r.acceptedAt,
      revokedAt: r.revokedAt,
      revokeReason: r.revokeReason,
      provisioningRecordId: r.provisioningRecordId,
    };
  }
}
