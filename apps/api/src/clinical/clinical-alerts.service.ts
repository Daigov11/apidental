import { randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import type { RequestMeta } from '../common/utils/request-meta.js';
import { withTxRetry } from '../common/utils/tx-retry.js';
import { requirePatient } from '../patients/patient-access.js';
import type { DbTx, PrismaDb } from '../prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';
import {
  ClinicalAccessService,
  type ClinicalAccessDecision,
  type ClinicalAccessLevel,
} from './clinical-access.service.js';
import {
  changedFieldNames,
  recordNotFound,
  stateConflict,
  versionConflict,
} from './clinical-versioning.js';
import type {
  ChangeAlertDto,
  CreateAlertDto,
  ListAlertsQuery,
} from './dto/history.dto.js';

type ChangeKind =
  | 'CREATED'
  | 'CORRECTED'
  | 'RECTIFIED'
  | 'DEACTIVATED'
  | 'REACTIVATED'
  | 'MARKED_IN_ERROR';
const FIELDS = ['severity', 'text', 'source', 'expiresAt'] as const;
const RANK: Record<string, number> = { CRITICAL: 0, WARNING: 1, INFO: 2 };

interface AlertRow {
  id: string;
  itemId: string;
  version: number;
  severity: string;
  text: string;
  source: string;
  status: string;
  expiresAt: Date | null;
  changeKind: string;
  changeReason: string | null;
  changedFields: unknown;
  createdById: string;
  createdAt: Date;
}

export interface AlertView {
  id: string;
  origin: 'MANUAL' | 'ALLERGY' | 'BACKGROUND';
  severity: string;
  label: string;
  validUntil: Date | null;
  /** Solo nivel completo. */
  source?: string;
  version?: number;
  status?: string;
  reason?: string | null;
}

/**
 * Alertas clínicas. Las DERIVADAS no se almacenan: nacen de las alergias y antecedentes críticos activos. Las
 * MANUALES son versionadas (como los antecedentes). Una alerta es informativa: no decide ni bloquea tratamientos.
 * El asistente recibe solo alertas activas y mínimas (origen, severidad, etiqueta breve y vigencia).
 */
@Injectable()
export class ClinicalAlertsService {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaDb,
    private readonly audit: AuditService,
    private readonly access: ClinicalAccessService,
  ) {}

  /** Alertas ya autorizadas (el llamador pasó por `authorize`). */
  async activeAlerts(
    clinicId: string,
    patientId: string,
    level: ClinicalAccessLevel,
    includeInactive = false,
  ): Promise<AlertView[]> {
    const full = level !== 'LIMITED';
    const now = new Date();
    const entries = await this.db.clinicalHistoryEntry.findMany({
      where: {
        clinicId,
        patientId,
        currentKey: { not: null },
        isCritical: true,
        ...(full && includeInactive
          ? { status: { not: 'ENTERED_IN_ERROR' } }
          : { status: 'ACTIVE' }),
      },
      select: {
        itemId: true,
        kind: true,
        label: true,
        status: true,
        version: true,
        source: true,
      },
    });
    const manual = await this.db.clinicalAlert.findMany({
      where: {
        clinicId,
        patientId,
        currentKey: { not: null },
        ...(full && includeInactive
          ? { status: { not: 'ENTERED_IN_ERROR' } }
          : {
              status: 'ACTIVE',
              OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
            }),
      },
    });
    const views: AlertView[] = [
      ...entries.map((e) => ({
        id: e.itemId,
        origin: e.kind as 'ALLERGY' | 'BACKGROUND',
        severity: 'CRITICAL',
        label: e.label,
        validUntil: null,
        ...(full
          ? { source: e.source, version: e.version, status: e.status }
          : {}),
      })),
      ...manual.map((a) => ({
        id: a.itemId,
        origin: 'MANUAL' as const,
        severity: a.severity,
        label: a.text,
        validUntil: a.expiresAt,
        ...(full
          ? {
              source: a.source,
              version: a.version,
              status: a.status,
              reason: a.changeReason,
            }
          : {}),
      })),
    ];
    return views.sort(
      (x, y) =>
        RANK[x.severity]! - RANK[y.severity]! || x.label.localeCompare(y.label),
    );
  }

  /** Lista de alertas: odontólogo y Director (nivel completo) o asistente (vista mínima). */
  async list(
    actor: AuthPrincipal,
    patientId: string,
    q: ListAlertsQuery,
    meta: RequestMeta,
  ) {
    const d = await this.access.authorize(
      actor,
      patientId,
      'read',
      ['alerts'],
      meta,
    );
    return {
      access: { level: d.level, via: d.via },
      advisory: true, // informativas: no toman decisiones clínicas ni bloquean tratamientos
      alerts: await this.activeAlerts(
        d.clinicId,
        patientId,
        d.level,
        Boolean(q.includeInactive),
      ),
    };
  }

  async versions(
    actor: AuthPrincipal,
    patientId: string,
    itemId: string,
    meta: RequestMeta,
  ) {
    const d = await this.access.authorize(
      actor,
      patientId,
      'read',
      ['alert_versions'],
      meta,
      { allowLimited: false },
    );
    const rows = await this.db.clinicalAlert.findMany({
      where: { clinicId: d.clinicId, patientId, itemId },
      orderBy: { version: 'desc' },
    });
    if (rows.length === 0) throw recordNotFound();
    return rows.map((r) => ({
      ...this.full(r as AlertRow),
      changedFields: r.changedFields ?? [],
    }));
  }

  async create(
    actor: AuthPrincipal,
    patientId: string,
    dto: CreateAlertDto,
    meta: RequestMeta,
  ) {
    const d = await this.access.authorize(
      actor,
      patientId,
      'write',
      ['alerts:create'],
      meta,
    );
    await requirePatient(this.db, d.clinicId, patientId, { active: true });
    const expiresAt = this.parseExpiry(dto.expiresAt);
    const itemId = randomUUID();
    const row = await withTxRetry(() =>
      this.db.$transaction(
        async (tx) => {
          await this.access.assertStillAuthorized(tx, actor, d, meta);
          const created = await tx.clinicalAlert.create({
            data: {
              clinicId: d.clinicId,
              patientId,
              itemId,
              version: 1,
              currentKey: itemId,
              severity: dto.severity,
              text: dto.text,
              source: dto.source,
              status: 'ACTIVE',
              expiresAt,
              changeKind: 'CREATED',
              changeReason: dto.reason ?? null,
              changedFields: [...FIELDS],
              createdById: actor.user.id,
            },
          });
          await this.auditChange(
            tx,
            actor,
            d,
            meta,
            created as AlertRow,
            'CREATED',
            [...FIELDS],
          );
          return created;
        },
        { isolationLevel: 'ReadCommitted' },
      ),
    );
    return this.full(row as AlertRow);
  }

  change(
    actor: AuthPrincipal,
    patientId: string,
    itemId: string,
    dto: ChangeAlertDto,
    meta: RequestMeta,
  ) {
    return this.newVersion(
      actor,
      patientId,
      itemId,
      dto.expectedVersion,
      dto.reason,
      'CORRECTED',
      meta,
      (prev) => {
        if (prev.status === 'ENTERED_IN_ERROR')
          throw stateConflict(
            'La alerta está marcada como ingresada por error; no admite cambios',
          );
        const next = { ...prev };
        if (dto.severity !== undefined) next.severity = dto.severity;
        if (dto.text !== undefined) next.text = dto.text;
        if (dto.source !== undefined) next.source = dto.source;
        if (dto.expiresAt !== undefined)
          next.expiresAt = this.parseExpiry(dto.expiresAt ?? undefined);
        return next;
      },
    );
  }

  transition(
    actor: AuthPrincipal,
    patientId: string,
    itemId: string,
    expectedVersion: number,
    reason: string,
    kind: 'DEACTIVATED' | 'REACTIVATED' | 'MARKED_IN_ERROR',
    meta: RequestMeta,
  ) {
    return this.newVersion(
      actor,
      patientId,
      itemId,
      expectedVersion,
      reason,
      kind,
      meta,
      (prev) => {
        if (kind === 'DEACTIVATED' && prev.status !== 'ACTIVE')
          throw stateConflict('Solo se desactiva una alerta activa');
        if (kind === 'REACTIVATED' && prev.status !== 'INACTIVE')
          throw stateConflict('Solo se reactiva una alerta inactiva');
        if (kind === 'MARKED_IN_ERROR' && prev.status === 'ENTERED_IN_ERROR')
          throw stateConflict(
            'La alerta ya está marcada como ingresada por error',
          );
        return {
          ...prev,
          status:
            kind === 'DEACTIVATED'
              ? 'INACTIVE'
              : kind === 'REACTIVATED'
                ? 'ACTIVE'
                : 'ENTERED_IN_ERROR',
        };
      },
    );
  }

  // ------------------------------------------------------------------ internos

  private async newVersion(
    actor: AuthPrincipal,
    patientId: string,
    itemId: string,
    expectedVersion: number,
    reason: string,
    kind: Exclude<ChangeKind, 'CREATED'>,
    meta: RequestMeta,
    apply: (prev: AlertRow) => AlertRow,
  ) {
    const d = await this.access.authorize(
      actor,
      patientId,
      'write',
      [`alerts:${kind.toLowerCase()}`],
      meta,
    );
    await requirePatient(this.db, d.clinicId, patientId, { active: true });
    const row = await withTxRetry(() =>
      this.db.$transaction(
        async (tx) => {
          await this.access.assertStillAuthorized(tx, actor, d, meta);
          const locked = await tx.$queryRaw<{ id: string; version: number }[]>`
            SELECT id, version FROM clinical_alerts
            WHERE item_id = ${itemId} AND clinic_id = ${d.clinicId} AND patient_id = ${patientId} AND current_key IS NOT NULL
            FOR UPDATE`;
          if (!locked[0]) throw recordNotFound();
          if (locked[0].version !== expectedVersion)
            throw versionConflict(locked[0].version);
          const prev = (await tx.clinicalAlert.findUniqueOrThrow({
            where: { id: locked[0].id },
          })) as AlertRow;
          const next = apply(prev);
          const fields =
            kind === 'CORRECTED'
              ? changedFieldNames(prev as never, next as never, FIELDS)
              : ['status'];
          if (fields.length === 0)
            throw new BadRequestException(
              'La corrección no modifica ningún campo',
            );
          await tx.clinicalAlert.update({
            where: { id: prev.id },
            data: { currentKey: null },
          });
          const created = await tx.clinicalAlert.create({
            data: {
              clinicId: d.clinicId,
              patientId,
              itemId,
              version: prev.version + 1,
              supersedesId: prev.id,
              currentKey: itemId,
              severity: next.severity as never,
              text: next.text,
              source: next.source as never,
              status: next.status as never,
              expiresAt: next.expiresAt,
              changeKind: kind,
              changeReason: reason,
              changedFields: fields,
              createdById: actor.user.id,
            },
          });
          await this.auditChange(
            tx,
            actor,
            d,
            meta,
            created as AlertRow,
            kind,
            fields,
          );
          return created;
        },
        { isolationLevel: 'ReadCommitted' },
      ),
    );
    return this.full(row as AlertRow);
  }

  private parseExpiry(value: string | undefined): Date | null {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime()))
      throw new BadRequestException('expiresAt no es una fecha válida');
    if (date.getTime() <= Date.now())
      throw new BadRequestException('expiresAt debe ser una fecha futura');
    return date;
  }

  private full(r: AlertRow) {
    return {
      id: r.itemId,
      version: r.version,
      origin: 'MANUAL' as const,
      severity: r.severity,
      text: r.text,
      source: r.source,
      status: r.status,
      validUntil: r.expiresAt,
      lastChange: {
        kind: r.changeKind,
        reason: r.changeReason,
        at: r.createdAt,
        byUserId: r.createdById,
      },
    };
  }

  private auditChange(
    tx: DbTx,
    actor: AuthPrincipal,
    d: ClinicalAccessDecision,
    meta: RequestMeta,
    row: AlertRow,
    kind: ChangeKind,
    fields: string[],
  ) {
    return this.audit.record(
      {
        action: `CLINICAL_ALERT_${kind}`,
        entity: 'ClinicalAlert',
        entityId: row.itemId,
        patientId: d.patientId,
        userId: actor.user.id,
        clinicId: d.clinicId,
        branchId: d.branchId,
        meta,
        summary: {
          itemId: row.itemId,
          version: row.version,
          changeKind: kind,
          fields,
          via: d.via,
        },
      },
      tx,
    );
  }
}
