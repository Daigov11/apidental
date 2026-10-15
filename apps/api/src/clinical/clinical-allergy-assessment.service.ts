import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import type { RequestMeta } from '../common/utils/request-meta.js';
import { withTxRetry } from '../common/utils/tx-retry.js';
import { requirePatient } from '../patients/patient-access.js';
import {
  formatDateOnly,
  isFutureDate,
  limaToday,
  toDateOnly,
} from '../patients/util/lima-date.js';
import type { DbTx, PrismaDb } from '../prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';
import {
  ClinicalAccessService,
  type ClinicalAccessDecision,
} from './clinical-access.service.js';
import { versionConflict } from './clinical-versioning.js';
import type { SetAllergyAssessmentDto } from './dto/history.dto.js';

type Status = 'NOT_ASKED' | 'NO_KNOWN_ALLERGIES' | 'ALLERGIES_RECORDED';

interface Row {
  id: string;
  version: number;
  status: string;
  assessedOn: Date;
  source: string;
  observations: string | null;
  changeKind: string;
  changeReason: string | null;
  automatic: boolean;
  createdById: string;
  createdAt: Date;
}

const AUTO_REASON = {
  recorded: 'El sistema registró una alergia activa',
  cleared: 'Ya no quedan alergias activas; la evaluación debe repetirse',
} as const;

const today = (): Date => {
  const [y, m, d] = limaToday();
  return new Date(Date.UTC(y, m - 1, d));
};

/**
 * Evaluación de alergias: estado EXPLÍCITO y VERSIONADO por paciente que distingue "no se preguntó" de "se preguntó
 * y no reporta alergias conocidas". Invariante: ALLERGIES_RECORDED <=> hay al menos una alergia activa vigente.
 *  - El profesional declara NOT_ASKED o NO_KNOWN_ALLERGIES (solo si NO hay alergias activas).
 *  - ALLERGIES_RECORDED lo pone el sistema al registrar una alergia activa; al quedar sin alergias activas vuelve a
 *    NOT_ASKED (hay que repetir la evaluación).
 * Se serializa con el bloqueo de la fila del paciente (el mismo que toman las altas y cambios de alergias), y la base de
 * datos impone la misma invariante.
 */
@Injectable()
export class ClinicalAllergyAssessmentService {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaDb,
    private readonly audit: AuditService,
    private readonly access: ClinicalAccessService,
  ) {}

  // ------------------------------------------------------------------- lectura

  /** Estado vigente (autorizado por el llamador). Sin filas: NOT_ASKED, o ALLERGIES_RECORDED derivado si hay alergias previas. */
  async currentView(clinicId: string, patientId: string) {
    const [row, count] = await Promise.all([
      this.db.clinicalAllergyAssessment.findFirst({
        where: { clinicId, patientId, currentKey: { not: null } },
      }),
      this.activeAllergies(this.db, clinicId, patientId),
    ]);
    if (!row) {
      return {
        status: count > 0 ? 'ALLERGIES_RECORDED' : 'NOT_ASKED',
        version: 0,
        derived: true,
        activeAllergyCount: count,
        assessedOn: null,
        source: null,
        observations: null,
        lastChange: null,
      };
    }
    return {
      ...this.present(row as Row),
      derived: false,
      activeAllergyCount: count,
    };
  }

  async get(actor: AuthPrincipal, patientId: string, meta: RequestMeta) {
    const d = await this.access.authorize(
      actor,
      patientId,
      'read',
      ['allergy_assessment'],
      meta,
      { allowLimited: false },
    );
    return this.currentView(d.clinicId, patientId);
  }

  async versions(actor: AuthPrincipal, patientId: string, meta: RequestMeta) {
    const d = await this.access.authorize(
      actor,
      patientId,
      'read',
      ['allergy_assessment_versions'],
      meta,
      { allowLimited: false },
    );
    const rows = await this.db.clinicalAllergyAssessment.findMany({
      where: { clinicId: d.clinicId, patientId },
      orderBy: { version: 'desc' },
    });
    return rows.map((r) => this.present(r as Row));
  }

  // ------------------------------------------------------------------ escritura

  async set(
    actor: AuthPrincipal,
    patientId: string,
    dto: SetAllergyAssessmentDto,
    meta: RequestMeta,
  ) {
    if (dto.status === 'ALLERGIES_RECORDED') {
      throw new BadRequestException(
        'ALLERGIES_RECORDED lo deriva el sistema al registrar una alergia activa; no se declara',
      );
    }
    const d = await this.access.authorize(
      actor,
      patientId,
      'write',
      ['allergy_assessment:set'],
      meta,
    );
    await requirePatient(this.db, d.clinicId, patientId, { active: true });
    const assessedOn = this.parseDate(dto.assessedOn);

    const row = await withTxRetry(() =>
      this.db.$transaction(
        async (tx) => {
          await this.access.assertStillAuthorized(tx, actor, d, meta);
          await this.lockPatient(tx, patientId);
          const cur = await this.lockCurrent(tx, d.clinicId, patientId);
          const curVersion = cur?.version ?? 0;
          if (curVersion !== dto.expectedVersion)
            throw versionConflict(curVersion);
          if ((await this.activeAllergies(tx, d.clinicId, patientId)) > 0) {
            throw new ConflictException({
              message:
                'Hay alergias activas registradas; la evaluación es ALLERGIES_RECORDED y no puede declararse otro estado',
              code: 'ALLERGIES_ACTIVE',
            });
          }
          if (cur && !dto.reason)
            throw new BadRequestException(
              'El motivo es obligatorio al modificar la evaluación de alergias',
            );
          if (
            cur &&
            cur.status === dto.status &&
            formatDateOnly(cur.assessedOn) === formatDateOnly(assessedOn) &&
            cur.source === dto.source &&
            (cur.observations ?? null) === (dto.observations || null)
          ) {
            throw new BadRequestException(
              'La evaluación no cambia respecto de la versión vigente',
            );
          }
          const created = await this.append(tx, d, actor.user.id, cur, {
            status: dto.status,
            assessedOn,
            source: dto.source,
            observations: dto.observations || null,
            reason: dto.reason ?? null,
            automatic: false,
          });
          await this.auditChange(tx, actor, d, meta, created, false, [
            'status',
            'assessedOn',
            'source',
            'observations',
          ]);
          return created;
        },
        { isolationLevel: 'ReadCommitted' },
      ),
    );
    return { ...this.present(row), derived: false, activeAllergyCount: 0 };
  }

  /**
   * Mantiene la invariante cuando cambian las alergias. Se invoca DENTRO de la transacción que modifica una alergia,
   * con el bloqueo del paciente ya tomado y DESPUÉS de escribir el cambio.
   */
  async syncInTx(
    tx: DbTx,
    actor: AuthPrincipal,
    d: ClinicalAccessDecision,
    meta: RequestMeta,
  ): Promise<void> {
    const count = await this.activeAllergies(tx, d.clinicId, d.patientId);
    const cur = await this.lockCurrent(tx, d.clinicId, d.patientId);
    let desired: Status | null = null;
    if (count > 0 && cur?.status !== 'ALLERGIES_RECORDED')
      desired = 'ALLERGIES_RECORDED';
    else if (count === 0 && cur?.status === 'ALLERGIES_RECORDED')
      desired = 'NOT_ASKED';
    if (!desired) return;
    const created = await this.append(tx, d, actor.user.id, cur, {
      status: desired,
      assessedOn: today(),
      source: 'PROFESSIONAL',
      observations: null,
      reason: cur
        ? desired === 'ALLERGIES_RECORDED'
          ? AUTO_REASON.recorded
          : AUTO_REASON.cleared
        : null,
      automatic: true,
    });
    await this.auditChange(tx, actor, d, meta, created, true, ['status']);
  }

  /** Bloqueo por paciente: serializa altas/cambios de alergias con la declaración de la evaluación. */
  async lockPatient(tx: DbTx, patientId: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM patients WHERE id = ${patientId} FOR UPDATE`;
  }

  // ------------------------------------------------------------------ internos

  private activeAllergies(
    db: DbTx | PrismaDb,
    clinicId: string,
    patientId: string,
  ): Promise<number> {
    return db.clinicalHistoryEntry.count({
      where: {
        clinicId,
        patientId,
        kind: 'ALLERGY',
        status: 'ACTIVE',
        currentKey: { not: null },
      },
    });
  }

  private async lockCurrent(
    tx: DbTx,
    clinicId: string,
    patientId: string,
  ): Promise<Row | null> {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM clinical_allergy_assessments
      WHERE patient_id = ${patientId} AND clinic_id = ${clinicId} AND current_key IS NOT NULL FOR UPDATE`;
    if (!locked[0]) return null;
    return (await tx.clinicalAllergyAssessment.findUniqueOrThrow({
      where: { id: locked[0].id },
    })) as Row;
  }

  private async append(
    tx: DbTx,
    d: ClinicalAccessDecision,
    authorId: string,
    cur: Row | null,
    v: {
      status: Status;
      assessedOn: Date;
      source: string;
      observations: string | null;
      reason: string | null;
      automatic: boolean;
    },
  ): Promise<Row> {
    if (cur)
      await tx.clinicalAllergyAssessment.update({
        where: { id: cur.id },
        data: { currentKey: null },
      });
    return (await tx.clinicalAllergyAssessment.create({
      data: {
        clinicId: d.clinicId,
        patientId: d.patientId,
        version: (cur?.version ?? 0) + 1,
        supersedesId: cur?.id ?? null,
        currentKey: d.patientId,
        status: v.status,
        assessedOn: v.assessedOn,
        source: v.source as never,
        observations: v.observations,
        changeKind: cur ? 'RECTIFIED' : 'CREATED',
        changeReason: v.reason,
        automatic: v.automatic,
        createdById: authorId,
      },
    })) as Row;
  }

  private parseDate(value: string | undefined): Date {
    if (!value) return today();
    const date = toDateOnly(value);
    if (
      Number.isNaN(date.getTime()) ||
      date.toISOString().slice(0, 10) !== value
    )
      throw new BadRequestException('assessedOn no es una fecha válida');
    if (isFutureDate(value))
      throw new BadRequestException('assessedOn no puede estar en el futuro');
    return date;
  }

  private present(r: Row) {
    return {
      status: r.status,
      version: r.version,
      assessedOn: formatDateOnly(r.assessedOn),
      source: r.source,
      observations: r.observations,
      lastChange: {
        kind: r.changeKind,
        reason: r.changeReason,
        at: r.createdAt,
        byUserId: r.createdById,
        automatic: r.automatic,
      },
    };
  }

  /** Solo versión y nombres de campos: ni el estado ni las observaciones van a la auditoría. */
  private auditChange(
    tx: DbTx,
    actor: AuthPrincipal,
    d: ClinicalAccessDecision,
    meta: RequestMeta,
    row: Row,
    automatic: boolean,
    fields: string[],
  ) {
    return this.audit.record(
      {
        action: automatic
          ? 'CLINICAL_ALLERGY_ASSESSMENT_AUTO_UPDATED'
          : 'CLINICAL_ALLERGY_ASSESSMENT_SET',
        entity: 'ClinicalAllergyAssessment',
        entityId: d.patientId,
        patientId: d.patientId,
        userId: actor.user.id,
        clinicId: d.clinicId,
        branchId: d.branchId,
        meta,
        summary: {
          version: row.version,
          changeKind: row.changeKind,
          automatic,
          fields,
          via: d.via,
        },
      },
      tx,
    );
  }
}
