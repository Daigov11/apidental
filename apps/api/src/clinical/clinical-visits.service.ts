import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import type { RequestMeta } from '../common/utils/request-meta.js';
import { withTxRetry } from '../common/utils/tx-retry.js';
import {
  clinicalConsentStatus,
  consentAlerts,
} from '../patients/consent-status.js';
import {
  isUniqueViolation,
  requirePatient,
} from '../patients/patient-access.js';
import type { DbTx, PrismaDb } from '../prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';
import {
  ClinicalAccessService,
  type ClinicalAccessDecision,
} from './clinical-access.service.js';
import { ClinicalAllergyAssessmentService } from './clinical-allergy-assessment.service.js';
import {
  assertVisitWriter,
  lockVisitExclusive,
  withVisitDenial,
} from './clinical-visit-access.js';
import {
  recordNotFound,
  stateConflict,
  versionConflict,
} from './clinical-versioning.js';
import type {
  CancelVisitDto,
  ListVisitsQuery,
  OpenVisitDto,
  VisitTransitionDto,
} from './dto/care.dto.js';

interface Row {
  id: string;
  patientId: string;
  branchId: string;
  dentistUserId: string;
  careRelationshipId: string;
  visitNumber: number;
  status: string;
  reason: string | null;
  startedAt: Date;
  closedAt: Date | null;
  cancelReason: string | null;
  appointmentId: string | null;
  version: number;
}

const present = (v: Row) => ({
  id: v.id,
  patientId: v.patientId,
  visitNumber: v.visitNumber,
  branchId: v.branchId,
  responsibleUserId: v.dentistUserId,
  status: v.status,
  reason: v.reason,
  startedAt: v.startedAt,
  closedAt: v.closedAt,
  cancelReason: v.cancelReason,
  careRelationshipId: v.careRelationshipId,
  version: v.version,
});

/**
 * Visita clínica. Abrirla NUNCA se bloquea por consentimiento faltante (solo se avisa). Exige relación asistencial
 * vigente, una sede en el contexto y que quien la abre sea el odontólogo responsable. Es una máquina de estados:
 * OPEN → CLOSED | CANCELLED, una sola vez, con versión optimista y bloqueo de la fila.
 */
@Injectable()
export class ClinicalVisitsService {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaDb,
    private readonly audit: AuditService,
    private readonly access: ClinicalAccessService,
    private readonly assessment: ClinicalAllergyAssessmentService,
  ) {}

  async open(
    actor: AuthPrincipal,
    patientId: string,
    dto: OpenVisitDto,
    meta: RequestMeta,
  ) {
    const d = await this.access.authorize(
      actor,
      patientId,
      'write',
      ['visit:open'],
      meta,
    );
    if (d.via === 'admin_access')
      throw new ForbiddenException(
        'Solo el odontólogo con relación asistencial puede abrir una visita',
      );
    if (!d.branchId)
      throw new BadRequestException(
        'Seleccione una sede para abrir una visita',
      );
    await requirePatient(this.db, d.clinicId, patientId, { active: true });
    const rels = await this.db.patientCareRelationship.findMany({
      where: { id: { in: d.relationshipIds } },
      select: { id: true, branchId: true },
    });
    const relationship =
      rels.find((r) => r.branchId === d.branchId) ??
      rels.find((r) => r.branchId === null) ??
      rels[0];
    if (!relationship)
      throw new BadRequestException(
        'No hay una relación asistencial aplicable',
      );

    try {
      const row = await withTxRetry(() =>
        this.db.$transaction(
          async (tx) => {
            await this.access.assertStillAuthorized(tx, actor, d, meta);
            await this.assessment.lockPatient(tx, patientId); // numeración correlativa sin huecos ni repetidos
            const last = await tx.clinicalVisit.aggregate({
              where: { patientId },
              _max: { visitNumber: true },
            });
            const created = await tx.clinicalVisit.create({
              data: {
                clinicId: d.clinicId,
                patientId,
                branchId: d.branchId!,
                dentistUserId: actor.user.id,
                careRelationshipId: relationship.id,
                visitNumber: (last._max.visitNumber ?? 0) + 1,
                openKey: `${patientId}|${actor.user.id}`,
                reason: dto.reason || null,
                createdById: actor.user.id,
              },
            });
            await this.record(
              tx,
              actor,
              d,
              meta,
              'OPENED',
              created.id,
              created.version,
              created.visitNumber,
            );
            return created;
          },
          { isolationLevel: 'ReadCommitted' },
        ),
      );
      // Aviso (no bloqueo): el consentimiento clínico faltante no impide abrir la visita.
      const warnings = consentAlerts(
        await clinicalConsentStatus(this.db, d.clinicId, patientId),
      ).map((a) => a.code);
      return { ...present(row as Row), warnings };
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException({
          message:
            'Ya tiene una visita abierta con este paciente; ciérrela o cancélela antes de abrir otra',
          code: 'VISIT_ALREADY_OPEN',
        });
      }
      throw error;
    }
  }

  async list(
    actor: AuthPrincipal,
    patientId: string,
    q: ListVisitsQuery,
    meta: RequestMeta,
  ) {
    const d = await this.access.authorize(
      actor,
      patientId,
      'read',
      ['visits'],
      meta,
      { allowLimited: false },
    );
    const rows = await this.db.clinicalVisit.findMany({
      where: {
        clinicId: d.clinicId,
        patientId,
        ...(q.status ? { status: q.status } : {}),
      },
      orderBy: { visitNumber: 'desc' },
      take: q.limit,
      skip: q.offset,
    });
    return rows.map((r) => present(r as Row));
  }

  async get(
    actor: AuthPrincipal,
    patientId: string,
    visitId: string,
    meta: RequestMeta,
  ) {
    const d = await this.access.authorize(
      actor,
      patientId,
      'read',
      ['visit'],
      meta,
      { allowLimited: false },
    );
    const visit = await this.db.clinicalVisit.findFirst({
      where: { id: visitId, clinicId: d.clinicId, patientId },
    });
    if (!visit) throw recordNotFound();
    const [diagnoses, procedures] = await Promise.all([
      this.db.clinicalDiagnosis.count({
        where: {
          visitId,
          currentKey: { not: null },
          status: { not: 'ENTERED_IN_ERROR' },
        },
      }),
      this.db.clinicalProcedure.count({
        where: {
          visitId,
          currentKey: { not: null },
          status: { not: 'ENTERED_IN_ERROR' },
        },
      }),
    ]);
    return { ...present(visit as Row), counts: { diagnoses, procedures } };
  }

  close(
    actor: AuthPrincipal,
    patientId: string,
    visitId: string,
    dto: VisitTransitionDto,
    meta: RequestMeta,
  ) {
    return this.transition(
      actor,
      patientId,
      visitId,
      dto.expectedVersion,
      'CLOSED',
      null,
      meta,
    );
  }

  cancel(
    actor: AuthPrincipal,
    patientId: string,
    visitId: string,
    dto: CancelVisitDto,
    meta: RequestMeta,
  ) {
    return this.transition(
      actor,
      patientId,
      visitId,
      dto.expectedVersion,
      'CANCELLED',
      dto.reason,
      meta,
    );
  }

  private async transition(
    actor: AuthPrincipal,
    patientId: string,
    visitId: string,
    expectedVersion: number,
    to: 'CLOSED' | 'CANCELLED',
    reason: string | null,
    meta: RequestMeta,
  ) {
    const d = await this.access.authorize(
      actor,
      patientId,
      'write',
      [`visit:${to.toLowerCase()}`],
      meta,
    );
    const row = await withVisitDenial(this.access, actor, patientId, meta, () =>
      withTxRetry(() =>
        this.db.$transaction(
          async (tx) => {
            await this.access.assertStillAuthorized(tx, actor, d, meta);
            // Bloqueo exclusivo: ningún diagnóstico ni procedimiento nuevo (que toman el bloqueo compartido) entra a mitad del cierre.
            const visit = await lockVisitExclusive(
              tx,
              visitId,
              d.clinicId,
              patientId,
            );
            assertVisitWriter(visit, actor, d);
            if (visit.status !== 'OPEN')
              throw stateConflict('La visita ya no está abierta');
            if (visit.version !== expectedVersion)
              throw versionConflict(visit.version);
            if (to === 'CLOSED') {
              const open = await tx.clinicalProcedure.count({
                where: { visitId, currentKey: { not: null }, status: 'OPEN' },
              });
              if (open > 0)
                throw new ConflictException({
                  message:
                    'Cierre o cancele los procedimientos abiertos antes de cerrar la visita',
                  code: 'OPEN_PROCEDURES',
                  count: open,
                });
              const drafts = await tx.clinicalNote.count({
                where: { visitId, currentKey: { not: null }, status: 'DRAFT' },
              });
              if (drafts > 0) {
                throw new ConflictException({
                  message:
                    'Cierre o descarte el borrador de la evolución antes de cerrar la visita',
                  code: 'OPEN_NOTE',
                  count: drafts,
                });
              }
            } else {
              const live = await tx.clinicalProcedure.count({
                where: {
                  visitId,
                  currentKey: { not: null },
                  status: { in: ['OPEN', 'CLOSED'] },
                },
              });
              if (live > 0)
                throw new ConflictException({
                  message:
                    'La visita tiene procedimientos vigentes; no puede cancelarse',
                  code: 'HAS_PROCEDURES',
                  count: live,
                });
              const notes = await tx.clinicalNote.count({
                where: {
                  visitId,
                  currentKey: { not: null },
                  status: { in: ['DRAFT', 'CLOSED'] },
                },
              });
              if (notes > 0) {
                throw new ConflictException({
                  message:
                    'La visita tiene una evolución vigente; no puede cancelarse',
                  code: 'HAS_NOTES',
                  count: notes,
                });
              }
            }
            const updated = await tx.clinicalVisit.update({
              where: { id: visitId },
              data: {
                status: to,
                openKey: null,
                version: { increment: 1 },
                ...(to === 'CLOSED'
                  ? { closedAt: new Date() }
                  : { cancelReason: reason }),
              },
            });
            await this.record(
              tx,
              actor,
              d,
              meta,
              to,
              visitId,
              updated.version,
              updated.visitNumber,
            );
            return updated;
          },
          { isolationLevel: 'ReadCommitted' },
        ),
      ),
    );
    return present(row as Row);
  }

  /** Referencias y número de versión: ni motivos ni contenido clínico. */
  private record(
    tx: DbTx,
    actor: AuthPrincipal,
    d: ClinicalAccessDecision,
    meta: RequestMeta,
    kind: string,
    visitId: string,
    version: number,
    visitNumber: number,
  ) {
    return this.audit.record(
      {
        action: `CLINICAL_VISIT_${kind}`,
        entity: 'ClinicalVisit',
        entityId: visitId,
        patientId: d.patientId,
        userId: actor.user.id,
        clinicId: d.clinicId,
        branchId: d.branchId,
        meta,
        summary: { visitId, visitNumber, version, via: d.via },
      },
      tx,
    );
  }
}
