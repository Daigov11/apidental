import { ClinicalAllergyAssessmentService } from './clinical-allergy-assessment.service.js';
import { randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import type { RequestMeta } from '../common/utils/request-meta.js';
import { withTxRetry } from '../common/utils/tx-retry.js';
import { requirePatient } from '../patients/patient-access.js';
import {
  formatDateOnly,
  isFutureDate,
  toDateOnly,
} from '../patients/util/lima-date.js';
import type { DbTx, PrismaDb } from '../prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';
import {
  ClinicalAccessService,
  type ClinicalAccessDecision,
} from './clinical-access.service.js';
import {
  changedFieldNames,
  recordNotFound,
  stateConflict,
  versionConflict,
} from './clinical-versioning.js';
import type {
  ChangeHistoryEntryDto,
  CreateHistoryEntryDto,
  ListHistoryQuery,
} from './dto/history.dto.js';

type ChangeKind =
  | 'CREATED'
  | 'CORRECTED'
  | 'RECTIFIED'
  | 'DEACTIVATED'
  | 'REACTIVATED'
  | 'MARKED_IN_ERROR';

const FIELDS = [
  'label',
  'condition',
  'category',
  'severity',
  'isCritical',
  'onsetDate',
  'source',
  'observations',
] as const;

interface Row {
  id: string;
  itemId: string;
  version: number;
  kind: string;
  label: string;
  condition: string | null;
  category: string | null;
  severity: string;
  status: string;
  isCritical: boolean;
  onsetDate: Date | null;
  source: string;
  observations: string | null;
  changeKind: string;
  changeReason: string | null;
  changedFields: unknown;
  createdById: string;
  createdAt: Date;
}

/** Vista completa (odontólogo con relación, o Director con autorización): se arma campo por campo. */
const present = (r: Row) => ({
  id: r.itemId,
  version: r.version,
  kind: r.kind,
  label: r.label,
  condition: r.condition,
  category: r.category,
  severity: r.severity,
  status: r.status,
  isCritical: r.isCritical,
  onsetDate: formatDateOnly(r.onsetDate),
  source: r.source,
  observations: r.observations,
  lastChange: {
    kind: r.changeKind,
    reason: r.changeReason,
    at: r.createdAt,
    byUserId: r.createdById,
  },
});

const presentVersion = (r: Row) => ({
  ...present(r),
  changedFields: r.changedFields ?? [],
});

/**
 * Antecedentes médicos y alergias, versionados. Cada operación pasa por `ClinicalAccessService` (relación
 * asistencial, vista limitada, autorización read_all) y se audita ANTES de entregar o, en escrituras, dentro de la
 * misma transacción. La auditoría guarda referencias, acción, versión y NOMBRES de campos: nunca el contenido.
 * Nada se elimina: corregir, rectificar, desactivar o marcar "por error" crean una versión nueva con motivo.
 */
@Injectable()
export class ClinicalHistoryService {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaDb,
    private readonly audit: AuditService,
    private readonly access: ClinicalAccessService,
    private readonly assessment: ClinicalAllergyAssessmentService,
  ) {}

  // ------------------------------------------------------------------- lectura

  async list(
    actor: AuthPrincipal,
    patientId: string,
    q: ListHistoryQuery,
    meta: RequestMeta,
  ) {
    const d = await this.access.authorize(
      actor,
      patientId,
      'read',
      ['history'],
      meta,
      { allowLimited: false },
    );
    const rows = await this.db.clinicalHistoryEntry.findMany({
      where: {
        clinicId: d.clinicId,
        patientId,
        currentKey: { not: null },
        status: q.status ?? { not: 'ENTERED_IN_ERROR' },
        ...(q.kind ? { kind: q.kind } : {}),
      },
      orderBy: [{ kind: 'asc' }, { createdAt: 'desc' }, { id: 'asc' }],
      take: q.limit,
      skip: q.offset,
    });
    return rows.map((r) => present(r as Row));
  }

  async get(
    actor: AuthPrincipal,
    patientId: string,
    itemId: string,
    meta: RequestMeta,
  ) {
    const d = await this.access.authorize(
      actor,
      patientId,
      'read',
      ['history'],
      meta,
      { allowLimited: false },
    );
    const row = await this.db.clinicalHistoryEntry.findFirst({
      where: {
        clinicId: d.clinicId,
        patientId,
        itemId,
        currentKey: { not: null },
      },
    });
    if (!row) throw recordNotFound();
    return present(row as Row);
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
      ['history_versions'],
      meta,
      { allowLimited: false },
    );
    const rows = await this.db.clinicalHistoryEntry.findMany({
      where: { clinicId: d.clinicId, patientId, itemId },
      orderBy: { version: 'desc' },
    });
    if (rows.length === 0) throw recordNotFound();
    return rows.map((r) => presentVersion(r as Row));
  }

  // ------------------------------------------------------------------ escritura

  async create(
    actor: AuthPrincipal,
    patientId: string,
    dto: CreateHistoryEntryDto,
    meta: RequestMeta,
  ) {
    const d = await this.access.authorize(
      actor,
      patientId,
      'write',
      ['history:create'],
      meta,
    );
    await requirePatient(this.db, d.clinicId, patientId, { active: true });
    const onsetDate = this.parseDate(dto.onsetDate);
    const itemId = randomUUID();
    const row = await withTxRetry(() =>
      this.db.$transaction(
        async (tx) => {
          await this.access.assertStillAuthorized(tx, actor, d, meta);
          await this.assessment.lockPatient(tx, patientId);
          const created = await tx.clinicalHistoryEntry.create({
            data: {
              clinicId: d.clinicId,
              patientId,
              itemId,
              version: 1,
              currentKey: itemId,
              kind: dto.kind,
              label: dto.label,
              condition: dto.condition || null,
              category: dto.category || null,
              severity: dto.severity ?? 'NOT_SPECIFIED',
              status: 'ACTIVE',
              isCritical: dto.isCritical ?? false,
              onsetDate,
              source: dto.source,
              observations: dto.observations || null,
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
            created as Row,
            'CREATED',
            [...FIELDS],
          );
          if (created.kind === 'ALLERGY')
            await this.assessment.syncInTx(tx, actor, d, meta);
          return created;
        },
        { isolationLevel: 'ReadCommitted' },
      ),
    );
    return present(row as Row);
  }

  /** Corrección (error de registro) o rectificación (actualizar la información): versión nueva con los campos indicados. */
  change(
    actor: AuthPrincipal,
    patientId: string,
    itemId: string,
    dto: ChangeHistoryEntryDto,
    kind: 'CORRECTED' | 'RECTIFIED',
    meta: RequestMeta,
  ) {
    return this.newVersion(
      actor,
      patientId,
      itemId,
      dto.expectedVersion,
      dto.reason,
      kind,
      meta,
      (prev) => {
        if (prev.status === 'ENTERED_IN_ERROR')
          throw stateConflict(
            'El registro está marcado como ingresado por error; no admite cambios',
          );
        const next = { ...prev };
        if (dto.label !== undefined) next.label = dto.label;
        if (dto.condition !== undefined) next.condition = dto.condition || null;
        if (dto.category !== undefined) next.category = dto.category || null;
        if (dto.severity !== undefined) next.severity = dto.severity;
        if (dto.isCritical !== undefined) next.isCritical = dto.isCritical;
        if (dto.onsetDate !== undefined)
          next.onsetDate =
            dto.onsetDate === null ? null : this.parseDate(dto.onsetDate)!;
        if (dto.source !== undefined) next.source = dto.source;
        if (dto.observations !== undefined)
          next.observations = dto.observations || null;
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
        const from = prev.status;
        if (kind === 'DEACTIVATED' && from !== 'ACTIVE')
          throw stateConflict('Solo se desactiva un registro activo');
        if (kind === 'REACTIVATED' && from !== 'INACTIVE')
          throw stateConflict('Solo se reactiva un registro inactivo');
        if (kind === 'MARKED_IN_ERROR' && from === 'ENTERED_IN_ERROR')
          throw stateConflict(
            'El registro ya está marcado como ingresado por error',
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
    apply: (prev: Row) => Row,
  ) {
    const d = await this.access.authorize(
      actor,
      patientId,
      'write',
      [`history:${kind.toLowerCase()}`],
      meta,
    );
    await requirePatient(this.db, d.clinicId, patientId, { active: true });
    const row = await withTxRetry(() =>
      this.db.$transaction(
        async (tx) => {
          await this.access.assertStillAuthorized(tx, actor, d, meta);
          await this.assessment.lockPatient(tx, patientId);
          // Bloqueo de la versión vigente: dos cambios simultáneos se serializan y el segundo ve la versión nueva.
          const locked = await tx.$queryRaw<{ id: string; version: number }[]>`
            SELECT id, version FROM clinical_history_entries
            WHERE item_id = ${itemId} AND clinic_id = ${d.clinicId} AND patient_id = ${patientId} AND current_key IS NOT NULL
            FOR UPDATE`;
          if (!locked[0]) throw recordNotFound();
          if (locked[0].version !== expectedVersion)
            throw versionConflict(locked[0].version);
          const prev = (await tx.clinicalHistoryEntry.findUniqueOrThrow({
            where: { id: locked[0].id },
          })) as Row;
          const next = apply(prev);
          const fields =
            kind === 'CORRECTED' || kind === 'RECTIFIED'
              ? changedFieldNames(prev as never, next as never, FIELDS)
              : ['status'];
          if (fields.length === 0)
            throw new BadRequestException(
              'La corrección no modifica ningún campo',
            );

          await tx.clinicalHistoryEntry.update({
            where: { id: prev.id },
            data: { currentKey: null },
          });
          const created = await tx.clinicalHistoryEntry.create({
            data: {
              clinicId: d.clinicId,
              patientId,
              itemId,
              version: prev.version + 1,
              supersedesId: prev.id,
              currentKey: itemId,
              kind: prev.kind as never,
              label: next.label,
              condition: next.condition,
              category: next.category,
              severity: next.severity as never,
              status: next.status as never,
              isCritical: next.isCritical,
              onsetDate: next.onsetDate,
              source: next.source as never,
              observations: next.observations,
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
            created as Row,
            kind,
            fields,
          );
          if (created.kind === 'ALLERGY')
            await this.assessment.syncInTx(tx, actor, d, meta);
          return created;
        },
        { isolationLevel: 'ReadCommitted' },
      ),
    );
    return present(row as Row);
  }

  private parseDate(value: string | undefined): Date | null {
    if (!value) return null;
    const date = toDateOnly(value);
    if (
      Number.isNaN(date.getTime()) ||
      date.toISOString().slice(0, 10) !== value
    )
      throw new BadRequestException('onsetDate no es una fecha válida');
    if (isFutureDate(value))
      throw new BadRequestException('onsetDate no puede estar en el futuro');
    return date;
  }

  /** Referencias, acción, versión y nombres de campos. Nunca etiquetas, condiciones, observaciones ni motivos. */
  private auditChange(
    tx: DbTx,
    actor: AuthPrincipal,
    d: ClinicalAccessDecision,
    meta: RequestMeta,
    row: Row,
    kind: ChangeKind,
    fields: string[],
  ) {
    return this.audit.record(
      {
        action: `CLINICAL_ENTRY_${kind}`,
        entity: 'ClinicalHistoryEntry',
        entityId: row.itemId,
        patientId: d.patientId,
        userId: actor.user.id,
        clinicId: d.clinicId,
        branchId: d.branchId,
        meta,
        summary: {
          itemId: row.itemId,
          version: row.version,
          entryKind: row.kind,
          changeKind: kind,
          fields,
          via: d.via,
        },
      },
      tx,
    );
  }
}
