import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
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
  ChangeProcedureDto,
  CreateProcedureDto,
  ListProceduresQuery,
} from './dto/care.dto.js';

type Kind =
  | 'CREATED'
  | 'CORRECTED'
  | 'RECTIFIED'
  | 'CLOSED'
  | 'CANCELLED'
  | 'MARKED_IN_ERROR';
const FIELDS = ['notes', 'performedAt'] as const;

interface Row {
  id: string;
  itemId: string;
  visitId: string;
  version: number;
  definitionId: string;
  definitionCode: string;
  definitionName: string;
  dentistUserId: string;
  notes: string | null;
  performedAt: Date;
  status: string;
  closedAt: Date | null;
  closureConsent: string | null;
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
  definition: {
    id: r.definitionId,
    code: r.definitionCode,
    name: r.definitionName,
  },
  responsibleUserId: r.dentistUserId,
  notes: r.notes,
  performedAt: r.performedAt,
  status: r.status,
  closedAt: r.closedAt,
  closureConsent: r.closureConsent,
  lastChange: {
    kind: r.changeKind,
    reason: r.changeReason,
    at: r.createdAt,
    byUserId: r.createdById,
  },
  declaredByProfessional: true,
});

class ConsentBlockedError extends Error {
  constructor(
    readonly row: Row,
    readonly clinicId: string,
  ) {
    super('consent');
  }
}

/**
 * Procedimientos realizados, versionados. Se registran en una visita abierta, por su odontólogo responsable y con un
 * tipo del catálogo de la clínica (se copian código y nombre). CERRAR un procedimiento cuya definición requiere
 * consentimiento clínico exige un consentimiento vigente: se verifica dentro de la transacción con un bloqueo
 * compartido del consentimiento (una revocación simultánea espera o gana) y la base de datos lo impone también. El
 * bloqueo se audita sin contenido clínico. No hay excepciones de consentimiento todavía.
 * Registrar, planificar o cancelar un procedimiento NUNCA se bloquea por consentimiento.
 */
@Injectable()
export class ClinicalProceduresService {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaDb,
    private readonly audit: AuditService,
    private readonly access: ClinicalAccessService,
  ) {}

  async list(
    actor: AuthPrincipal,
    patientId: string,
    q: ListProceduresQuery,
    meta: RequestMeta,
  ) {
    const d = await this.access.authorize(
      actor,
      patientId,
      'read',
      ['procedures'],
      meta,
      { allowLimited: false },
    );
    const rows = await this.db.clinicalProcedure.findMany({
      where: {
        clinicId: d.clinicId,
        patientId,
        currentKey: { not: null },
        status: q.status ?? { not: 'ENTERED_IN_ERROR' },
        ...(q.visitId ? { visitId: q.visitId } : {}),
      },
      orderBy: [{ performedAt: 'desc' }, { id: 'asc' }],
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
      ['procedures'],
      meta,
      { allowLimited: false },
    );
    const row = await this.db.clinicalProcedure.findFirst({
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
      ['procedure_versions'],
      meta,
      { allowLimited: false },
    );
    const rows = await this.db.clinicalProcedure.findMany({
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
    dto: CreateProcedureDto,
    meta: RequestMeta,
  ) {
    const d = await this.access.authorize(
      actor,
      patientId,
      'write',
      ['procedure:create'],
      meta,
    );
    await requirePatient(this.db, d.clinicId, patientId, { active: true });
    const performedAt = this.parseDate(dto.performedAt) ?? new Date();
    // Definición del catálogo de ESTA clínica (404 uniforme si no existe o es de otra clínica).
    const def = await this.db.procedureDefinition.findFirst({
      where: { id: dto.definitionId, clinicId: d.clinicId },
    });
    if (!def)
      throw new NotFoundException('Procedimiento del catálogo no encontrado');
    if (def.status !== 'ACTIVE')
      throw new ConflictException({
        message: 'El procedimiento del catálogo está inactivo',
        code: 'DEFINITION_INACTIVE',
      });
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
                'La visita no está abierta; solo se registran procedimientos nuevos en una visita abierta',
              );
            const created = await tx.clinicalProcedure.create({
              data: {
                clinicId: d.clinicId,
                patientId,
                visitId,
                itemId,
                version: 1,
                currentKey: itemId,
                definitionId: def.id,
                definitionCode: def.code,
                definitionName: def.name,
                dentistUserId: visit.dentistUserId,
                notes: dto.notes || null,
                performedAt,
                status: 'OPEN',
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
    dto: ChangeProcedureDto,
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
        if (prev.status !== 'OPEN' && prev.status !== 'CLOSED')
          throw stateConflict(
            'Solo se corrige un procedimiento abierto o cerrado',
          );
        const next = { ...prev };
        if (dto.notes !== undefined) next.notes = dto.notes || null;
        if (dto.performedAt !== undefined)
          next.performedAt = this.parseDate(dto.performedAt)!;
        return next;
      },
    );
  }

  cancel(
    actor: AuthPrincipal,
    patientId: string,
    itemId: string,
    expectedVersion: number,
    reason: string,
    meta: RequestMeta,
  ) {
    return this.newVersion(
      actor,
      patientId,
      itemId,
      expectedVersion,
      reason,
      'CANCELLED',
      meta,
      (prev) => {
        if (prev.status !== 'OPEN')
          throw stateConflict('Solo se cancela un procedimiento abierto');
        return { ...prev, status: 'CANCELLED' };
      },
    );
  }

  markError(
    actor: AuthPrincipal,
    patientId: string,
    itemId: string,
    expectedVersion: number,
    reason: string,
    meta: RequestMeta,
  ) {
    return this.newVersion(
      actor,
      patientId,
      itemId,
      expectedVersion,
      reason,
      'MARKED_IN_ERROR',
      meta,
      (prev) => {
        if (prev.status === 'ENTERED_IN_ERROR')
          throw stateConflict(
            'El procedimiento ya está marcado como ingresado por error',
          );
        return { ...prev, status: 'ENTERED_IN_ERROR' };
      },
    );
  }

  /** Cierra el procedimiento. Si su definición exige consentimiento clínico y no hay uno vigente: 409 y auditoría del bloqueo. */
  async close(
    actor: AuthPrincipal,
    patientId: string,
    itemId: string,
    expectedVersion: number,
    meta: RequestMeta,
  ) {
    try {
      return await this.newVersion(
        actor,
        patientId,
        itemId,
        expectedVersion,
        null,
        'CLOSED',
        meta,
        (prev) => {
          if (prev.status !== 'OPEN')
            throw stateConflict('Solo se cierra un procedimiento abierto');
          return { ...prev, status: 'CLOSED' };
        },
      );
    } catch (error) {
      if (error instanceof ConsentBlockedError) {
        const revoked = await this.db.patientConsent.count({
          where: {
            clinicId: error.clinicId,
            patientId,
            type: 'CLINICAL',
            status: 'REVOKED',
          },
        });
        await this.audit.recordSafely({
          action: 'CLINICAL_PROCEDURE_CLOSE_BLOCKED',
          entity: 'ClinicalProcedure',
          entityId: error.row.itemId,
          patientId,
          userId: actor.user.id,
          clinicId: actor.context?.clinicId ?? null,
          branchId: actor.context?.branchId ?? null,
          meta,
          // Referencias y causa; ni el procedimiento, ni notas, ni diagnósticos.
          summary: {
            itemId: error.row.itemId,
            visitId: error.row.visitId,
            definitionId: error.row.definitionId,
            version: error.row.version,
            reason: revoked > 0 ? 'consent_revoked' : 'consent_missing',
          },
        });
        throw new ConflictException({
          message:
            'La definición de este procedimiento requiere un consentimiento clínico vigente del paciente; regístrelo antes de cerrarlo',
          code: 'CLINICAL_CONSENT_REQUIRED',
          consentState: revoked > 0 ? 'REVOKED' : 'MISSING',
        });
      }
      throw error;
    }
  }

  private async newVersion(
    actor: AuthPrincipal,
    patientId: string,
    itemId: string,
    expectedVersion: number,
    reason: string | null,
    kind: Exclude<Kind, 'CREATED'>,
    meta: RequestMeta,
    apply: (prev: Row) => Row,
  ) {
    const d = await this.access.authorize(
      actor,
      patientId,
      'write',
      [`procedure:${kind.toLowerCase()}`],
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
              SELECT id, version, visit_id FROM clinical_procedures
              WHERE item_id = ${itemId} AND clinic_id = ${d.clinicId} AND patient_id = ${patientId} AND current_key IS NOT NULL FOR UPDATE`;
            if (!locked[0]) throw recordNotFound();
            const visit = await lockVisitShared(
              tx,
              locked[0].visit_id,
              d.clinicId,
              patientId,
            );
            assertVisitWriter(visit, actor, d);
            if (locked[0].version !== expectedVersion)
              throw versionConflict(locked[0].version);
            const prev = (await tx.clinicalProcedure.findUniqueOrThrow({
              where: { id: locked[0].id },
            })) as Row;
            if (
              (kind === 'CLOSED' || kind === 'CANCELLED') &&
              visit.status !== 'OPEN'
            ) {
              throw stateConflict(
                'La visita no está abierta; no se cierra ni se cancela un procedimiento',
              );
            }
            const next = apply(prev);
            let closure: {
              closedAt: Date;
              closureConsent: 'NOT_REQUIRED' | 'GRANTED';
            } | null = null;
            if (kind === 'CLOSED') {
              const def = await tx.procedureDefinition.findUniqueOrThrow({
                where: { id: prev.definitionId },
              });
              let consent: 'NOT_REQUIRED' | 'GRANTED' = 'NOT_REQUIRED';
              if (def.requiresClinicalConsent) {
                // Bloqueo compartido: una revocación simultánea espera (o ya ganó) y el cierre ve su resultado.
                const granted = await tx.$queryRaw<{ id: string }[]>`
                  SELECT id FROM patient_consents
                  WHERE clinic_id = ${d.clinicId} AND patient_id = ${patientId} AND type = 'CLINICAL' AND status = 'GRANTED' FOR SHARE`;
                if (granted.length === 0)
                  throw new ConsentBlockedError(prev, d.clinicId);
                consent = 'GRANTED';
              }
              closure = { closedAt: new Date(), closureConsent: consent };
            }
            const fields =
              kind === 'CORRECTED' || kind === 'RECTIFIED'
                ? changedFieldNames(prev as never, next as never, FIELDS)
                : ['status'];
            if (fields.length === 0)
              throw new BadRequestException(
                'La corrección no modifica ningún campo',
              );
            await tx.clinicalProcedure.update({
              where: { id: prev.id },
              data: { currentKey: null },
            });
            const created = await tx.clinicalProcedure.create({
              data: {
                clinicId: d.clinicId,
                patientId,
                visitId: prev.visitId,
                itemId,
                version: prev.version + 1,
                supersedesId: prev.id,
                currentKey: itemId,
                definitionId: prev.definitionId,
                definitionCode: prev.definitionCode,
                definitionName: prev.definitionName,
                dentistUserId: prev.dentistUserId,
                notes: next.notes,
                performedAt: next.performedAt,
                status: next.status as never,
                closedAt: closure?.closedAt ?? prev.closedAt,
                closureConsent:
                  closure?.closureConsent ?? (prev.closureConsent as never),
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

  private parseDate(value: string | undefined): Date | null {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime()))
      throw new BadRequestException('performedAt no es una fecha válida');
    if (date.getTime() > Date.now() + 5 * 60_000)
      throw new BadRequestException('performedAt no puede estar en el futuro');
    return date;
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
        action: `CLINICAL_PROCEDURE_${kind}`,
        entity: 'ClinicalProcedure',
        entityId: row.itemId,
        patientId: d.patientId,
        userId: actor.user.id,
        clinicId: d.clinicId,
        branchId: d.branchId,
        meta,
        summary: {
          itemId: row.itemId,
          visitId: row.visitId,
          definitionId: row.definitionId,
          version: row.version,
          changeKind: kind,
          fields,
          via: d.via,
          ...(kind === 'CLOSED' ? { consentVerified: row.closureConsent } : {}),
        },
      },
      tx,
    );
  }
}
