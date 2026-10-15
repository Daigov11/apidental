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
} from './clinical-access.service.js';
import {
  assertVisitWriter,
  lockVisitShared,
  withVisitDenial,
} from './clinical-visit-access.js';
import {
  changedFieldNames,
  recordNotFound,
  stateConflict,
  versionConflict,
} from './clinical-versioning.js';
import type {
  ChangeDiagnosisDto,
  CreateDiagnosisDto,
  ListDiagnosesQuery,
} from './dto/care.dto.js';

type Kind =
  | 'CREATED'
  | 'CORRECTED'
  | 'RECTIFIED'
  | 'DEACTIVATED'
  | 'REACTIVATED'
  | 'MARKED_IN_ERROR';
const FIELDS = ['description', 'code', 'certainty'] as const;

interface Row {
  id: string;
  itemId: string;
  visitId: string;
  version: number;
  description: string;
  code: string | null;
  certainty: string;
  status: string;
  changeKind: string;
  changeReason: string | null;
  changedFields: unknown;
  createdById: string;
  createdAt: Date;
}

const present = (r: Row) => ({
  id: r.itemId,
  visitId: r.visitId,
  version: r.version,
  description: r.description,
  code: r.code,
  certainty: r.certainty,
  status: r.status,
  lastChange: {
    kind: r.changeKind,
    reason: r.changeReason,
    at: r.createdAt,
    byUserId: r.createdById,
  },
  // Declaración del profesional: no es una recomendación ni dispara decisiones automáticas.
  declaredByProfessional: true,
});

/**
 * Diagnósticos DECLARADOS por el profesional, versionados (sin borrado físico). Solo se registran en una visita
 * abierta y por su odontólogo responsable; corregir o rectificar exige motivo y la versión que se leyó. Todo pasa por
 * el motor de acceso clínico; la auditoría guarda referencias, versión y nombres de campos, nunca el diagnóstico.
 * Registrar un diagnóstico NO depende del consentimiento clínico.
 */
@Injectable()
export class ClinicalDiagnosesService {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaDb,
    private readonly audit: AuditService,
    private readonly access: ClinicalAccessService,
  ) {}

  async list(
    actor: AuthPrincipal,
    patientId: string,
    q: ListDiagnosesQuery,
    meta: RequestMeta,
  ) {
    const d = await this.access.authorize(
      actor,
      patientId,
      'read',
      ['diagnoses'],
      meta,
      { allowLimited: false },
    );
    const rows = await this.db.clinicalDiagnosis.findMany({
      where: {
        clinicId: d.clinicId,
        patientId,
        currentKey: { not: null },
        status: q.status ?? { not: 'ENTERED_IN_ERROR' },
        ...(q.visitId ? { visitId: q.visitId } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
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
      ['diagnoses'],
      meta,
      { allowLimited: false },
    );
    const row = await this.db.clinicalDiagnosis.findFirst({
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
      ['diagnosis_versions'],
      meta,
      { allowLimited: false },
    );
    const rows = await this.db.clinicalDiagnosis.findMany({
      where: { clinicId: d.clinicId, patientId, itemId },
      orderBy: { version: 'desc' },
    });
    if (rows.length === 0) throw recordNotFound();
    return rows.map((r) => ({
      ...present(r as Row),
      changedFields: r.changedFields ?? [],
    }));
  }

  async create(
    actor: AuthPrincipal,
    patientId: string,
    visitId: string,
    dto: CreateDiagnosisDto,
    meta: RequestMeta,
  ) {
    const d = await this.access.authorize(
      actor,
      patientId,
      'write',
      ['diagnosis:create'],
      meta,
    );
    await requirePatient(this.db, d.clinicId, patientId, { active: true });
    const itemId = randomUUID();
    const row = await withVisitDenial(this.access, actor, patientId, meta, () =>
      withTxRetry(() =>
        this.db.$transaction(
          async (tx) => {
            await this.access.assertStillAuthorized(tx, actor, d, meta);
            const visit = await lockVisitShared(
              tx,
              visitId,
              d.clinicId,
              patientId,
            );
            assertVisitWriter(visit, actor, d);
            if (visit.status !== 'OPEN')
              throw stateConflict(
                'La visita no está abierta; solo se registran diagnósticos nuevos en una visita abierta',
              );
            const created = await tx.clinicalDiagnosis.create({
              data: {
                clinicId: d.clinicId,
                patientId,
                visitId,
                itemId,
                version: 1,
                currentKey: itemId,
                description: dto.description,
                code: dto.code || null,
                certainty: dto.certainty,
                status: 'ACTIVE',
                changeKind: 'CREATED',
                changeReason: dto.reason ?? null,
                changedFields: [...FIELDS],
                createdById: actor.user.id,
              },
            });
            await this.record(tx, actor, d, meta, created as Row, 'CREATED', [
              ...FIELDS,
            ]);
            return created;
          },
          { isolationLevel: 'ReadCommitted' },
        ),
      ),
    );
    return present(row as Row);
  }

  change(
    actor: AuthPrincipal,
    patientId: string,
    itemId: string,
    dto: ChangeDiagnosisDto,
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
            'El diagnóstico está marcado como ingresado por error; no admite cambios',
          );
        const next = { ...prev };
        if (dto.description !== undefined) next.description = dto.description;
        if (dto.code !== undefined) next.code = dto.code || null;
        if (dto.certainty !== undefined) next.certainty = dto.certainty;
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
          throw stateConflict('Solo se desactiva un diagnóstico activo');
        if (kind === 'REACTIVATED' && prev.status !== 'INACTIVE')
          throw stateConflict('Solo se reactiva un diagnóstico inactivo');
        if (kind === 'MARKED_IN_ERROR' && prev.status === 'ENTERED_IN_ERROR')
          throw stateConflict(
            'El diagnóstico ya está marcado como ingresado por error',
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

  private async newVersion(
    actor: AuthPrincipal,
    patientId: string,
    itemId: string,
    expectedVersion: number,
    reason: string,
    kind: Exclude<Kind, 'CREATED'>,
    meta: RequestMeta,
    apply: (prev: Row) => Row,
  ) {
    const d = await this.access.authorize(
      actor,
      patientId,
      'write',
      [`diagnosis:${kind.toLowerCase()}`],
      meta,
    );
    await requirePatient(this.db, d.clinicId, patientId, { active: true });
    const row = await withVisitDenial(this.access, actor, patientId, meta, () =>
      withTxRetry(() =>
        this.db.$transaction(
          async (tx) => {
            await this.access.assertStillAuthorized(tx, actor, d, meta);
            const locked = await tx.$queryRaw<
              { id: string; version: number; visit_id: string }[]
            >`
              SELECT id, version, visit_id FROM clinical_diagnoses
              WHERE item_id = ${itemId} AND clinic_id = ${d.clinicId} AND patient_id = ${patientId} AND current_key IS NOT NULL FOR UPDATE`;
            if (!locked[0]) throw recordNotFound();
            // Corregir un diagnóstico de una visita ya cerrada es válido (queda versionado); la responsabilidad sigue siendo del odontólogo de la visita.
            const visit = await lockVisitShared(
              tx,
              locked[0].visit_id,
              d.clinicId,
              patientId,
            );
            assertVisitWriter(visit, actor, d);
            if (locked[0].version !== expectedVersion)
              throw versionConflict(locked[0].version);
            const prev = (await tx.clinicalDiagnosis.findUniqueOrThrow({
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
            await tx.clinicalDiagnosis.update({
              where: { id: prev.id },
              data: { currentKey: null },
            });
            const created = await tx.clinicalDiagnosis.create({
              data: {
                clinicId: d.clinicId,
                patientId,
                visitId: prev.visitId,
                itemId,
                version: prev.version + 1,
                supersedesId: prev.id,
                currentKey: itemId,
                description: next.description,
                code: next.code,
                certainty: next.certainty as never,
                status: next.status as never,
                changeKind: kind,
                changeReason: reason,
                changedFields: fields,
                createdById: actor.user.id,
              },
            });
            await this.record(tx, actor, d, meta, created as Row, kind, fields);
            return created;
          },
          { isolationLevel: 'ReadCommitted' },
        ),
      ),
    );
    return present(row as Row);
  }

  private record(
    tx: DbTx,
    actor: AuthPrincipal,
    d: ClinicalAccessDecision,
    meta: RequestMeta,
    row: Row,
    kind: Kind,
    fields: string[],
  ) {
    return this.audit.record(
      {
        action: `CLINICAL_DIAGNOSIS_${kind}`,
        entity: 'ClinicalDiagnosis',
        entityId: row.itemId,
        patientId: d.patientId,
        userId: actor.user.id,
        clinicId: d.clinicId,
        branchId: d.branchId,
        meta,
        summary: {
          itemId: row.itemId,
          visitId: row.visitId,
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
