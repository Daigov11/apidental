import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AuditAction, AuditService } from '../audit/audit.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { ReauthService } from '../auth/reauth.service.js';
import type { RequestMeta } from '../common/utils/request-meta.js';
import { AppConfig } from '../config/app-config.js';
import { isFutureDate, limaToday, toDateOnly } from '../patients/util/lima-date.js';
import { maskEmail, maskTail } from '../patients/util/mask.js';
import { normalizeIdentifier } from '../patients/util/normalize.js';
import type { DbTx, PrismaDb } from '../prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';
import type { CreateProvisioningRecordDto } from './dto/provisioning.dto.js';

export const PROVISIONING_NOTICE =
  'Registro declarativo: el sistema no verifica la autenticidad del documento citado ni sustituye un contrato o una firma.';

/** Antigüedad máxima del documento que respalda la autorización. */
const MAX_DOCUMENT_AGE_DAYS = 365;

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';
}

/**
 * Registro formal de aprovisionamiento: antes de designar al PRIMER Director Clínico, la clínica debe
 * dejar constancia de quién lo autoriza y con qué documento. Es un registro **declarativo**: mientras no
 * exista firma electrónica ni un flujo contractual integrado, el sistema no puede verificar que el
 * documento exista ni que lo haya firmado quien se dice. Lo que sí garantiza: lo registra un
 * administrador de la clínica autenticado y reautenticado (la plataforma no puede), queda inmutable y
 * auditado, vence, se vincula a un único destinatario y se consume al aceptarse la invitación.
 */
@Injectable()
export class ProvisioningService {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaDb,
    private readonly audit: AuditService,
    private readonly reauth: ReauthService,
    private readonly config: AppConfig,
  ) {}

  /** Vence los registros cuyo plazo terminó (auditado una sola vez por registro). */
  async expireDue(): Promise<number> {
    const now = new Date();
    const due = await this.db.provisioningRecord.findMany({
      where: { status: 'ACTIVE', expiresAt: { lte: now } },
      select: { id: true, clinicId: true },
      take: 200,
    });
    for (const r of due) {
      const res = await this.db.provisioningRecord.updateMany({ where: { id: r.id, status: 'ACTIVE' }, data: { status: 'EXPIRED', activeKey: null } });
      if (res.count === 1) {
        await this.audit.recordSafely({ action: AuditAction.ProvisioningExpired, entity: 'ProvisioningRecord', entityId: r.id, clinicId: r.clinicId });
      }
    }
    return due.length;
  }

  async record(actor: AuthPrincipal, dto: CreateProvisioningRecordDto, meta: RequestMeta) {
    const clinicId = actor.context?.clinicId;
    if (!clinicId) throw new ForbiddenException('El aprovisionamiento lo registra la propia clínica, no la plataforma');
    await this.expireDue();

    const directors = await this.activeDirectorCount(this.db, clinicId);
    if (directors > 0) throw new ConflictException('La clínica ya tiene un Director Clínico; no requiere aprovisionamiento inicial');

    const documentNumber = this.normalizeDocument(dto.authorizedByDocumentType, dto.authorizedByDocumentNumber);
    const authorizationDate = this.parseAuthorizationDate(dto.authorizationDate);

    try {
      const row = await this.db.$transaction(async (tx) => {
        // La prueba de reautenticación se gasta en la misma transacción: si algo falla, no se pierde.
        await this.reauth.consume(
          { userId: actor.user.id, sessionId: actor.sessionId },
          dto.reauthToken,
          'AUTHORIZE_DIRECTOR_PROVISIONING',
          clinicId,
          meta,
          tx,
        );
        const created = await tx.provisioningRecord.create({
          data: {
            clinicId,
            kind: 'FIRST_CLINICAL_DIRECTOR',
            activeKey: `${clinicId}|FIRST_CLINICAL_DIRECTOR`,
            designeeName: dto.designeeName,
            designeeEmail: dto.designeeEmail,
            authorizedByName: dto.authorizedByName,
            authorizedByPosition: dto.authorizedByPosition,
            authorizedByDocumentType: dto.authorizedByDocumentType,
            authorizedByDocumentNumber: documentNumber,
            authorizationReference: dto.authorizationReference,
            authorizationDate,
            notes: dto.notes ?? null,
            recordedById: actor.user.id,
            expiresAt: new Date(Date.now() + this.config.provisioningTtlDays * 86_400_000),
          },
        });
        await this.audit.record(
          {
            action: AuditAction.ProvisioningRecorded,
            entity: 'ProvisioningRecord',
            entityId: created.id,
            userId: actor.user.id,
            clinicId,
            meta,
            // Sin nombres ni documento completo: solo lo necesario para trazar.
            summary: {
              kind: created.kind,
              designee: maskEmail(dto.designeeEmail),
              authorizerDocument: `${dto.authorizedByDocumentType} ${maskTail(documentNumber)}`,
              authorizationDate: dto.authorizationDate,
              selfDesignation: dto.designeeEmail === actor.user.email.toLowerCase(),
              expiresAt: created.expiresAt.toISOString(),
            },
          },
          tx,
        );
        return created;
      });
      return this.view(row);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('Ya existe un registro de aprovisionamiento vigente para esta clínica');
      throw error;
    }
  }

  async list(actor: AuthPrincipal) {
    const clinicId = actor.context?.clinicId;
    if (!clinicId) throw new ForbiddenException('Los registros de aprovisionamiento son de la clínica');
    await this.expireDue();
    const rows = await this.db.provisioningRecord.findMany({ where: { clinicId }, orderBy: { createdAt: 'desc' }, take: 50 });
    return rows.map((r) => this.view(r));
  }

  /** Revoca un registro vigente (y las invitaciones de Director pendientes que dependan de él). */
  async revoke(actor: AuthPrincipal, id: string, reason: string, meta: RequestMeta) {
    const clinicId = actor.context?.clinicId;
    if (!clinicId) throw new ForbiddenException('Los registros de aprovisionamiento son de la clínica');
    const record = await this.db.provisioningRecord.findFirst({ where: { id, clinicId } });
    if (!record) throw new NotFoundException('Registro no encontrado');
    if (record.status !== 'ACTIVE') throw new ConflictException('Solo se puede revocar un registro vigente');

    await this.db.$transaction(async (tx) => {
      const res = await tx.provisioningRecord.updateMany({
        where: { id, status: 'ACTIVE' },
        data: { status: 'REVOKED', activeKey: null, revokedAt: new Date(), revokedById: actor.user.id, revokeReason: reason },
      });
      if (res.count !== 1) throw new ConflictException('Solo se puede revocar un registro vigente');
      const pending = await tx.invitation.findMany({ where: { provisioningRecordId: id, status: 'PENDING' }, select: { id: true } });
      for (const inv of pending) {
        await tx.invitation.update({
          where: { id: inv.id },
          data: { status: 'REVOKED', pendingKey: null, revokedAt: new Date(), revokedById: actor.user.id, revokeReason: 'Registro de aprovisionamiento revocado' },
        });
        await this.audit.record(
          { action: AuditAction.InvitationRevoked, entity: 'Invitation', entityId: inv.id, userId: actor.user.id, clinicId, meta, summary: { cause: 'provisioning_revoked' } },
          tx,
        );
      }
      await this.audit.record(
        {
          action: AuditAction.ProvisioningRevoked,
          entity: 'ProvisioningRecord',
          entityId: id,
          userId: actor.user.id,
          clinicId,
          meta,
          summary: { reason, invitationsRevoked: pending.length },
        },
        tx,
      );
    });
    return this.view(await this.db.provisioningRecord.findUniqueOrThrow({ where: { id } }));
  }

  // ---- usados por el flujo de invitaciones ----

  /** El registro debe estar vigente, ser de esa clínica y dirigirse exactamente a ese correo. */
  async assertUsable(db: DbTx | PrismaDb, clinicId: string, recordId: string, designeeEmail: string) {
    const record = await db.provisioningRecord.findFirst({ where: { id: recordId, clinicId, kind: 'FIRST_CLINICAL_DIRECTOR' } });
    if (!record || record.status !== 'ACTIVE' || record.expiresAt <= new Date()) {
      throw new ForbiddenException('El registro de aprovisionamiento no existe, venció o ya no está vigente');
    }
    if (record.designeeEmail !== designeeEmail) {
      throw new ForbiddenException('El correo de la invitación no coincide con el designado en el registro de aprovisionamiento');
    }
    return record;
  }

  async consume(tx: DbTx, recordId: string, invitationId: string, clinicId: string, meta: RequestMeta, userId: string): Promise<void> {
    const res = await tx.provisioningRecord.updateMany({
      where: { id: recordId, status: 'ACTIVE' },
      data: { status: 'CONSUMED', activeKey: null, consumedAt: new Date(), consumedInvitationId: invitationId },
    });
    if (res.count !== 1) throw new ConflictException('El registro de aprovisionamiento ya no está vigente');
    await this.audit.record(
      { action: AuditAction.ProvisioningConsumed, entity: 'ProvisioningRecord', entityId: recordId, userId, clinicId, meta, summary: { invitationId } },
      tx,
    );
  }

  activeDirectorCount(db: DbTx | PrismaDb, clinicId: string): Promise<number> {
    return db.userAssignment.count({
      where: { clinicId, status: 'ACTIVE', role: { code: 'CLINICAL_DIRECTOR' }, user: { status: 'ACTIVE' } },
    });
  }

  // ---- utilidades ----

  private normalizeDocument(type: string, raw: string): string {
    if (type === 'RUC') {
      const v = raw.replace(/[\s-]/g, '');
      if (!/^\d{11}$/.test(v)) throw new BadRequestException('El RUC debe tener 11 dígitos');
      return v;
    }
    return normalizeIdentifier(type as 'DNI' | 'CE' | 'PASSPORT', raw);
  }

  private parseAuthorizationDate(value: string): Date {
    const date = toDateOnly(value);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
      throw new BadRequestException('authorizationDate no es una fecha válida');
    }
    if (isFutureDate(value)) throw new BadRequestException('La fecha del documento no puede ser futura');
    const [y, m, d] = limaToday();
    const oldest = new Date(Date.UTC(y, m - 1, d) - MAX_DOCUMENT_AGE_DAYS * 86_400_000);
    if (date < oldest) throw new BadRequestException('El documento de autorización tiene más de un año de antigüedad');
    return date;
  }

  private view(r: {
    id: string;
    clinicId: string;
    kind: string;
    status: string;
    designeeName: string;
    designeeEmail: string;
    authorizedByName: string;
    authorizedByPosition: string;
    authorizedByDocumentType: string;
    authorizedByDocumentNumber: string;
    authorizationReference: string;
    authorizationDate: Date;
    notes: string | null;
    recordedById: string;
    createdAt: Date;
    expiresAt: Date;
    consumedAt: Date | null;
    revokedAt: Date | null;
    revokeReason: string | null;
  }) {
    return {
      id: r.id,
      kind: r.kind,
      status: r.status,
      designee: { name: r.designeeName, email: r.designeeEmail },
      authorizedBy: {
        name: r.authorizedByName,
        position: r.authorizedByPosition,
        documentType: r.authorizedByDocumentType,
        documentNumber: maskTail(r.authorizedByDocumentNumber),
      },
      authorizationReference: r.authorizationReference,
      authorizationDate: r.authorizationDate.toISOString().slice(0, 10),
      notes: r.notes,
      recordedById: r.recordedById,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      consumedAt: r.consumedAt,
      revokedAt: r.revokedAt,
      revokeReason: r.revokeReason,
      notice: PROVISIONING_NOTICE,
    };
  }
}
