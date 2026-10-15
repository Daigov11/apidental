import { Prisma } from '../generated/prisma/client.js';
import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { DbTx } from '../prisma/client.js';
import { AuditAction, AuditService } from '../audit/audit.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { ReauthService } from '../auth/reauth.service.js';
import type { RequestMeta } from '../common/utils/request-meta.js';
import { withTxRetry } from '../common/utils/tx-retry.js';
import type { PrismaDb } from '../prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';
import {
  READ_ALL_GRANT_MINUTES,
  READ_ALL_GRANT_MS,
} from './clinical.constants.js';
import { ClinicalAccessDeniedException } from './clinical.errors.js';
import type { RequestClinicalAccessDto } from './dto/clinical.dto.js';

export type ClinicalIntent = 'read' | 'write';
export type ClinicalAccessLevel = 'FULL' | 'LIMITED' | 'READ_ALL' | 'VIEW';

export interface ClinicalAccessDecision {
  level: ClinicalAccessLevel;
  via: 'care_relationship' | 'support_view' | 'read_all_grant' | 'view_only' | 'admin_access';
  clinicId: string;
  branchId: string | null;
  patientId: string;
  /** Relaciones que fundamentan el acceso (vacío con `read_all`). */
  relationshipIds: string[];
  grant: { id: string; expiresAt: Date; category: string } | null;
}

interface Denial {
  reason: string;
  code: string;
  message: string;
}

const DENIALS = {
  noClinic: {
    reason: 'no_clinic_context',
    code: 'CLINIC_CONTEXT_REQUIRED',
    message: 'El acceso clínico solo existe dentro del contexto de una clínica',
  },
  noPermission: {
    reason: 'missing_permission',
    code: 'CLINICAL_PERMISSION_REQUIRED',
    message: 'Su rol no permite esta operación clínica',
  },
  noRelationship: {
    reason: 'no_care_relationship',
    code: 'NO_CARE_RELATIONSHIP',
    message:
      'No tiene una relación asistencial vigente con este paciente; solicite que se le asigne',
  },
  wrongBranch: {
    reason: 'wrong_branch',
    code: 'WRONG_BRANCH',
    message:
      'La relación asistencial corresponde a otra sede; seleccione esa sede para registrar información clínica',
  },
  limitedView: {
    reason: 'limited_view_only',
    code: 'CLINICAL_LIMITED_VIEW',
    message:
      'Su perfil solo accede a la vista de apoyo (alertas); este contenido clínico no está disponible',
  },
  justification: {
    reason: 'justification_required',
    code: 'CLINICAL_JUSTIFICATION_REQUIRED',
    message:
      'Para leer a este paciente debe solicitar una autorización justificada (con reautenticación)',
  },
} as const satisfies Record<string, Denial>;

/**
 * Motor de decisión del acceso clínico (falla cerrada). Un permiso clínico NO basta: hace falta además
 *  - odontólogo (`clinical:read`/`clinical:write`): relación asistencial VIGENTE con el paciente;
 *  - asistente (`clinical:read_limited`): el paciente tiene una relación vigente en su sede (vista de apoyo);
 *  - Director (`clinical:read_all`): una autorización de lectura vigente para ESE paciente, de su sesión;
 *  - Administración (`clinical:admin`): ve y registra en cualquier paciente de la clínica (siempre auditado);
 *  - Recepción (`clinical:view`): solo lectura (vista visual) de cualquier paciente de la clínica; nunca escribe.
 * El paciente siempre debe ser de la clínica del contexto; uno ajeno responde 404 igual que uno inexistente.
 * Todo acceso, permitido o denegado, se audita; el permitido se audita ANTES de entregar el dato y, si la
 * auditoría falla, no se entrega.
 */
@Injectable()
export class ClinicalAccessService {
  private readonly logger = new Logger(ClinicalAccessService.name);

  constructor(
    @Inject(PRISMA) private readonly db: PrismaDb,
    private readonly audit: AuditService,
    private readonly reauth: ReauthService,
  ) {}

  // ================================================================ decidir

  async authorize(
    actor: AuthPrincipal,
    patientId: string,
    intent: ClinicalIntent,
    sections: readonly string[],
    meta: RequestMeta,
    /** `false`: el contenido exige el nivel completo; la vista de apoyo (asistente) se deniega y se audita. */
    opts: { allowLimited?: boolean } = {},
  ): Promise<ClinicalAccessDecision> {
    const allowLimited = opts.allowLimited ?? true;
    const ctx = actor.context;
    if (!ctx || ctx.clinicId === null)
      return this.deny(actor, null, intent, meta, DENIALS.noClinic);
    const { clinicId, branchId } = ctx;

    const patient = await this.db.patient.findFirst({
      where: { id: patientId, clinicId },
      select: { id: true },
    });
    if (!patient) {
      // Mismo resultado para "no existe" y "es de otra clínica": no se revela la existencia ni se registra el id pedido.
      await this.auditDenied(actor, null, intent, meta, {
        reason: 'patient_unavailable',
      });
      throw new NotFoundException('Paciente no encontrado');
    }

    const now = new Date();
    const relationships = await this.db.patientCareRelationship.findMany({
      where: {
        clinicId,
        patientId,
        status: 'ACTIVE',
        OR: [{ validUntil: null }, { validUntil: { gt: now } }],
      },
      select: { id: true, dentistUserId: true, branchId: true },
    });
    const perms = actor.permissions;
    let denial: Denial = DENIALS.noPermission;

    // 0) Administración de la clínica (clinical:admin): acceso total a cualquier paciente de la clínica, auditado.
    if (perms.has('clinical:admin')) {
      return this.allow(
        actor,
        { level: 'FULL', via: 'admin_access', clinicId, branchId, patientId, relationshipIds: [], grant: null },
        intent,
        sections,
        meta,
      );
    }

    // 1) Odontólogo: relación asistencial propia (lectura: cualquier sede de la clínica; escritura: su sede de origen).
    if (perms.has(intent === 'write' ? 'clinical:write' : 'clinical:read')) {
      const mine = relationships.filter(
        (r) => r.dentistUserId === actor.user.id,
      );
      const usable =
        intent === 'write'
          ? mine.filter((r) => r.branchId === null || r.branchId === branchId)
          : mine; // continuidad asistencial: lee lo atendido en otras sedes mientras siga asignado a la clínica
      if (usable.length > 0) {
        return this.allow(
          actor,
          {
            level: 'FULL',
            via: 'care_relationship',
            clinicId,
            branchId,
            patientId,
            relationshipIds: usable.map((r) => r.id),
            grant: null,
          },
          intent,
          sections,
          meta,
        );
      }
      denial = mine.length > 0 ? DENIALS.wrongBranch : DENIALS.noRelationship;
    }

    if (intent === 'read') {
      // 1b) Recepción (clinical:view): vista de solo lectura de cualquier paciente de la clínica. Nunca escribe.
      if (perms.has('clinical:view')) {
        return this.allow(
          actor,
          { level: 'VIEW', via: 'view_only', clinicId, branchId, patientId, relationshipIds: [], grant: null },
          intent,
          sections,
          meta,
        );
      }
      // 2) Director: autorización de lectura justificada, de ESTE paciente y de ESTA sesión.
      if (perms.has('clinical:read_all')) {
        const grant = await this.db.clinicalAccessGrant.findFirst({
          where: {
            clinicId,
            patientId,
            userId: actor.user.id,
            sessionId: actor.sessionId,
            expiresAt: { gt: now },
          },
          orderBy: { expiresAt: 'desc' },
          select: { id: true, expiresAt: true, category: true },
        });
        if (grant) {
          return this.allow(
            actor,
            {
              level: 'READ_ALL',
              via: 'read_all_grant',
              clinicId,
              branchId,
              patientId,
              relationshipIds: [],
              grant,
            },
            intent,
            sections,
            meta,
          );
        }
        denial = DENIALS.justification;
      }
      // 3) Asistente: vista de apoyo de pacientes en atención en su sede.
      if (perms.has('clinical:read_limited')) {
        const inBranch = relationships.filter(
          (r) =>
            r.branchId === null || branchId === null || r.branchId === branchId,
        );
        if (inBranch.length > 0 && !allowLimited) {
          denial = DENIALS.limitedView;
        } else if (inBranch.length > 0) {
          return this.allow(
            actor,
            {
              level: 'LIMITED',
              via: 'support_view',
              clinicId,
              branchId,
              patientId,
              relationshipIds: inBranch.map((r) => r.id),
              grant: null,
            },
            intent,
            sections,
            meta,
          );
        } else {
          denial = DENIALS.noRelationship;
        }
      }
    }
    return this.deny(actor, patientId, intent, meta, denial);
  }

  /**
   * Revalida DENTRO de la transacción de una escritura que la relación asistencial sigue vigente. El bloqueo
   * compartido (LOCK IN SHARE MODE) hace que una revocación concurrente espere a que la escritura confirme: o se revoca
   * ANTES (la escritura se deniega) o DESPUÉS (la escritura ya era válida). Nunca queda una escritura posterior a una
   * revocación ya confirmada.
   */
  async assertStillAuthorized(
    tx: DbTx,
    actor: AuthPrincipal,
    decision: ClinicalAccessDecision,
    meta: RequestMeta,
  ): Promise<void> {
    if (decision.relationshipIds.length === 0) return; // read_all no escribe; el resto exige relación
    const live = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM patient_care_relationships
      WHERE id IN (${Prisma.join(decision.relationshipIds)}) AND status = 'ACTIVE'
        AND (valid_until IS NULL OR valid_until > UTC_TIMESTAMP(3))
      LOCK IN SHARE MODE`;
    if (live.length === 0) {
      await this.auditDenied(actor, decision.patientId, 'write', meta, {
        reason: 'relationship_revoked_during_write',
      });
      throw new ClinicalAccessDeniedException(
        DENIALS.noRelationship.message,
        DENIALS.noRelationship.code,
      );
    }
  }

  /** Auditoría PREVIA a la entrega. Si no se puede registrar, el acceso se deniega (falla cerrada). */
  private async allow(
    actor: AuthPrincipal,
    decision: ClinicalAccessDecision,
    intent: ClinicalIntent,
    sections: readonly string[],
    meta: RequestMeta,
  ): Promise<ClinicalAccessDecision> {
    const action =
      intent === 'write'
        ? AuditAction.ClinicalWriteAuthorized
        : decision.level === 'READ_ALL'
          ? AuditAction.ClinicalReadAllRead
          : AuditAction.ClinicalRecordViewed;
    try {
      await this.audit.record({
        action,
        entity: 'Patient',
        entityId: decision.patientId,
        patientId: decision.patientId,
        userId: actor.user.id,
        clinicId: decision.clinicId,
        branchId: decision.branchId,
        meta,
        summary: {
          level: decision.level,
          via: decision.via,
          intent,
          sections: [...sections],
          relationshipIds: decision.relationshipIds,
          ...(decision.grant
            ? { grantId: decision.grant.id, category: decision.grant.category }
            : {}),
        },
      });
    } catch (error) {
      this.logger.error(
        `Auditoría clínica no registrada; se deniega el acceso: ${error instanceof Error ? error.message : 'error'}`,
      );
      throw new ServiceUnavailableException(
        'No se pudo registrar el acceso clínico; por seguridad no se entregó información',
      );
    }
    return decision;
  }

  private async deny(
    actor: AuthPrincipal,
    patientId: string | null,
    intent: ClinicalIntent,
    meta: RequestMeta,
    denial: Denial,
  ): Promise<never> {
    await this.auditDenied(actor, patientId, intent, meta, {
      reason: denial.reason,
    });
    throw new ClinicalAccessDeniedException(denial.message, denial.code);
  }

  /** Negativa por una regla de la operación (p. ej. no ser el responsable de la visita): se audita igual que las demás. */
  denyBy(
    actor: AuthPrincipal,
    patientId: string,
    meta: RequestMeta,
    denial: { reason: string; code: string; message: string },
  ): Promise<never> {
    return this.deny(actor, patientId, 'write', meta, denial);
  }

  private auditDenied(
    actor: AuthPrincipal,
    patientId: string | null,
    intent: ClinicalIntent,
    meta: RequestMeta,
    detail: { reason: string },
  ): Promise<void> {
    return this.audit.recordSafely({
      action: AuditAction.ClinicalAccessDenied,
      entity: 'Patient',
      // Solo se registra el paciente cuando pertenece a la clínica del usuario.
      entityId: patientId,
      patientId,
      userId: actor.user.id,
      clinicId: actor.context?.clinicId ?? null,
      branchId: actor.context?.branchId ?? null,
      meta,
      summary: { intent, reason: detail.reason, roles: actor.roles },
    });
  }

  // ===================================================== autorización read_all

  /**
   * El Director pide leer a UN paciente: categoría + motivo (≥10 caracteres) + reautenticación CLINICAL_READ_ALL
   * emitida para ese paciente. Crea una autorización de 30 minutos, atada a su sesión y a ese paciente; el
   * registro de auditoría se escribe en la misma transacción (si falla, no hay autorización).
   */
  async requestReadAll(
    actor: AuthPrincipal,
    patientId: string,
    dto: RequestClinicalAccessDto,
    meta: RequestMeta,
  ) {
    const ctx = actor.context;
    if (!ctx || ctx.clinicId === null)
      return this.deny(actor, null, 'read', meta, DENIALS.noClinic);
    const { clinicId, branchId } = ctx;
    const patient = await this.db.patient.findFirst({
      where: { id: patientId, clinicId },
      select: { id: true },
    });
    if (!patient) {
      await this.auditDenied(actor, null, 'read', meta, {
        reason: 'patient_unavailable',
      });
      throw new NotFoundException('Paciente no encontrado');
    }

    const grantedAt = new Date();
    const expiresAt = new Date(grantedAt.getTime() + READ_ALL_GRANT_MS);
    try {
      const grant = await withTxRetry(() =>
        this.db.$transaction(
          async (tx) => {
            // Si la prueba no sirve (otro paciente, usada, vencida...) se lanza antes de crear nada.
            await this.reauth.consume(
              { userId: actor.user.id, sessionId: actor.sessionId },
              dto.reauthToken,
              'CLINICAL_READ_ALL',
              patientId,
              meta,
              tx,
            );
            const row = await tx.clinicalAccessGrant.create({
              data: {
                clinicId,
                patientId,
                userId: actor.user.id,
                sessionId: actor.sessionId,
                category: dto.category,
                reason: dto.reason,
                grantedAt,
                expiresAt,
                ip: meta.ip,
                userAgent: meta.userAgent,
              },
              select: { id: true, category: true, expiresAt: true },
            });
            await this.audit.record(
              {
                action: AuditAction.ClinicalReadAllGranted,
                entity: 'ClinicalAccessGrant',
                entityId: row.id,
                patientId,
                userId: actor.user.id,
                clinicId,
                branchId,
                meta,
                summary: {
                  grantId: row.id,
                  category: dto.category,
                  reason: dto.reason,
                  expiresAt: expiresAt.toISOString(),
                  minutes: READ_ALL_GRANT_MINUTES,
                },
              },
              tx,
            );
            return row;
          },
          { isolationLevel: 'ReadCommitted' },
        ),
      );
      return {
        grantId: grant.id,
        patientId,
        category: grant.category,
        expiresAt: grant.expiresAt,
        expiresInSeconds: Math.floor(READ_ALL_GRANT_MS / 1000),
        scope: 'single_patient' as const,
        readOnly: true,
      };
    } catch (error) {
      if (error instanceof ClinicalAccessDeniedException) throw error;
      if ((error as { status?: number }).status === 403) {
        // Reautenticación inválida: ya quedó REAUTH_REJECTED; se agrega la negativa clínica con el paciente.
        await this.auditDenied(actor, patientId, 'read', meta, {
          reason: 'reauthentication_failed',
        });
        throw new ClinicalAccessDeniedException(
          'Reautenticación inválida, vencida o ya utilizada',
          'REAUTHENTICATION_REQUIRED',
        );
      }
      if ((error as { status?: number }).status) throw error;
      this.logger.error(
        `No se pudo crear la autorización read_all: ${error instanceof Error ? error.message : 'error'}`,
      );
      throw new ServiceUnavailableException(
        'No se pudo registrar la autorización; por seguridad no se otorgó acceso',
      );
    }
  }
}
