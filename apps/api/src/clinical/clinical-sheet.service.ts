import { Inject, Injectable } from '@nestjs/common';
import type { AuthPrincipal } from '../auth/auth.types.js';
import type { RequestMeta } from '../common/utils/request-meta.js';
import {
  clinicalConsentStatus,
  consentAlerts,
} from '../patients/consent-status.js';
import { fullName } from '../patients/patient-view.js';
import { ageOn, isMinor } from '../patients/util/lima-date.js';
import type { PrismaDb } from '../prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';
import { ClinicalAccessService } from './clinical-access.service.js';
import { ClinicalAllergyAssessmentService } from './clinical-allergy-assessment.service.js';
import { ClinicalAlertsService } from './clinical-alerts.service.js';
import { CLINICAL_LABELS, SHEET_NOTICE } from './clinical-labels.js';
import { presentNote, type NoteRow } from './clinical-notes.service.js';
import { recordNotFound } from './clinical-versioning.js';

/**
 * "Ficha de atención": TODO lo que necesita la pantalla de una visita en una sola lectura, en el orden en que se mira:
 * alertas → diagnóstico → procedimientos → evolución. Es de solo lectura, pasa por el motor de acceso (una única
 * auditoría previa, sección `visit_sheet`) y calcula qué acciones puede hacer quien la mira, para que el panel no
 * tenga que deducir permisos. El asistente no la recibe (su vista es solo de alertas).
 */
@Injectable()
export class ClinicalSheetService {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaDb,
    private readonly access: ClinicalAccessService,
    private readonly alerts: ClinicalAlertsService,
    private readonly assessment: ClinicalAllergyAssessmentService,
  ) {}

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
      ['visit_sheet'],
      meta,
      { allowLimited: false },
    );
    const visit = await this.db.clinicalVisit.findFirst({
      where: { id: visitId, clinicId: d.clinicId, patientId },
    });
    if (!visit) throw recordNotFound();
    const patient = await this.db.patient.findFirstOrThrow({
      where: { id: patientId, clinicId: d.clinicId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        secondLastName: true,
        birthDate: true,
      },
    });
    const consent = await clinicalConsentStatus(this.db, d.clinicId, patientId);
    const [alerts, allergyAssessment, diagnoses, procedures, note] =
      await Promise.all([
        this.alerts.activeAlerts(d.clinicId, patientId, d.level),
        this.assessment.currentView(d.clinicId, patientId),
        this.db.clinicalDiagnosis.findMany({
          where: {
            visitId,
            clinicId: d.clinicId,
            currentKey: { not: null },
            status: { not: 'ENTERED_IN_ERROR' },
          },
          orderBy: { createdAt: 'asc' },
        }),
        this.db.clinicalProcedure.findMany({
          where: {
            visitId,
            clinicId: d.clinicId,
            currentKey: { not: null },
            status: { not: 'ENTERED_IN_ERROR' },
          },
          orderBy: { performedAt: 'asc' },
        }),
        this.db.clinicalNote.findFirst({
          where: { visitId, clinicId: d.clinicId, visitKey: { not: null } },
        }),
      ]);
    const defs = await this.db.procedureDefinition.findMany({
      where: {
        clinicId: d.clinicId,
        id: { in: [...new Set(procedures.map((p) => p.definitionId))] },
      },
      select: { id: true, requiresClinicalConsent: true },
    });
    const requires = new Map(
      defs.map((x) => [x.id, x.requiresClinicalConsent]),
    );

    // Puede actuar solo el odontólogo responsable, con relación, desde la sede de la visita. La lectura excepcional del Director nunca escribe.
    const responsible =
      d.level === 'FULL' &&
      visit.dentistUserId === actor.user.id &&
      d.branchId === visit.branchId;
    const open = visit.status === 'OPEN';
    const openProcedures = procedures.filter((p) => p.status === 'OPEN').length;
    const draft = note?.status === 'DRAFT';
    const closeVisitBlockedBy = [
      ...(openProcedures > 0 ? ['OPEN_PROCEDURES'] : []),
      ...(draft ? ['OPEN_NOTE'] : []),
    ];

    return {
      alerts: { advisory: true, items: alerts },
      patient: {
        id: patient.id,
        fullName: fullName(patient),
        age: patient.birthDate ? ageOn(patient.birthDate) : null,
        isMinor: isMinor(patient.birthDate),
      },
      allergyAssessment: {
        ...allergyAssessment,
        label:
          CLINICAL_LABELS.allergyAssessment[
            allergyAssessment.status as keyof typeof CLINICAL_LABELS.allergyAssessment
          ],
      },
      consent: {
        state: consent.state,
        label: CLINICAL_LABELS.consent[consent.state],
        alerts: consentAlerts(consent),
      },
      visit: {
        id: visit.id,
        number: visit.visitNumber,
        status: visit.status,
        statusLabel: CLINICAL_LABELS.visit[visit.status],
        reason: visit.reason,
        startedAt: visit.startedAt,
        closedAt: visit.closedAt,
        responsibleUserId: visit.dentistUserId,
        branchId: visit.branchId,
        version: visit.version,
      },
      diagnoses: diagnoses.map((x) => ({
        id: x.itemId,
        version: x.version,
        description: x.description,
        code: x.code,
        certainty: x.certainty,
        certaintyLabel: CLINICAL_LABELS.certainty[x.certainty],
        status: x.status,
        statusLabel:
          CLINICAL_LABELS.diagnosis[x.status as 'ACTIVE' | 'INACTIVE'],
      })),
      procedures: procedures.map((p) => {
        const needsConsent = requires.get(p.definitionId) === true;
        const blocked =
          p.status === 'OPEN' && needsConsent && consent.state !== 'GRANTED';
        return {
          id: p.itemId,
          version: p.version,
          name: p.definitionName,
          code: p.definitionCode,
          notes: p.notes,
          performedAt: p.performedAt,
          status: p.status,
          statusLabel: CLINICAL_LABELS.procedure[p.status],
          requiresConsent: needsConsent,
          // Aviso previo para que la pantalla lo muestre antes de intentar cerrar; el servidor lo vuelve a comprobar al cerrar.
          closeBlockedByConsent: blocked,
          closeBlockedMessage: blocked
            ? 'Para cerrar este procedimiento falta el consentimiento clínico del paciente.'
            : null,
          canClose: responsible && open && p.status === 'OPEN' && !blocked,
        };
      }),
      evolution: note
        ? presentNote(note as NoteRow, visit.dentistUserId === actor.user.id)
        : null,
      actions: {
        readOnly: !responsible,
        canAddDiagnosis: responsible && open,
        canAddProcedure: responsible && open,
        canWriteEvolution: responsible && open && (!note || draft),
        canCloseEvolution: responsible && open && draft,
        canCorrectEvolution: responsible && note?.status === 'CLOSED',
        canCloseVisit: responsible && open && closeVisitBlockedBy.length === 0,
        closeVisitBlockedBy,
      },
      access: { level: d.level, via: d.via },
      labels: CLINICAL_LABELS,
      notice: SHEET_NOTICE,
    };
  }
}
