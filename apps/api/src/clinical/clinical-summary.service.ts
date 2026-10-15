import { Inject, Injectable } from '@nestjs/common';
import type { AuthPrincipal } from '../auth/auth.types.js';
import type { RequestMeta } from '../common/utils/request-meta.js';
import {
  clinicalConsentStatus,
  consentAlerts,
} from '../patients/consent-status.js';
import { fullName } from '../patients/patient-view.js';
import { ageOn, formatDateOnly, isMinor } from '../patients/util/lima-date.js';
import type { PrismaDb } from '../prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';
import { ClinicalAccessService } from './clinical-access.service.js';
import { ClinicalAlertsService } from './clinical-alerts.service.js';

/**
 * Resumen clínico del paciente: la ÚNICA superficie clínica de 3.1. Aún no hay antecedentes, alergias,
 * diagnósticos ni evoluciones; el resumen entrega el control de acceso ya aplicado, las alertas derivadas
 * (consentimiento clínico) y los datos de apoyo. Los módulos clínicos futuros reutilizan
 * `ClinicalAccessService.authorize` y se enchufan en `sections`.
 *
 * Vista por nivel de acceso:
 *  - FULL (odontólogo con relación) y READ_ALL (Director con autorización): paciente, alertas y secciones clínicas.
 *  - LIMITED (asistente): solo alertas y datos de apoyo; sin fecha de nacimiento, sexo ni secciones clínicas.
 */
@Injectable()
export class ClinicalSummaryService {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaDb,
    private readonly access: ClinicalAccessService,
    private readonly clinicalAlerts: ClinicalAlertsService,
  ) {}

  async get(actor: AuthPrincipal, patientId: string, meta: RequestMeta) {
    // Autoriza y AUDITA antes de leer o entregar nada.
    const decision = await this.access.authorize(
      actor,
      patientId,
      'read',
      ['summary'],
      meta,
    );

    const patient = await this.db.patient.findFirstOrThrow({
      where: { id: patientId, clinicId: decision.clinicId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        secondLastName: true,
        birthDate: true,
        sex: true,
        status: true,
      },
    });
    const consent = await clinicalConsentStatus(
      this.db,
      decision.clinicId,
      patientId,
    );
    const alerts = consentAlerts(consent);
    const clinicalAlerts = await this.clinicalAlerts.activeAlerts(
      decision.clinicId,
      patientId,
      decision.level,
    );
    const access = {
      level: decision.level,
      via: decision.via,
      readOnly: decision.level !== 'FULL',
      ...(decision.grant
        ? {
            grant: {
              id: decision.grant.id,
              expiresAt: decision.grant.expiresAt,
            },
          }
        : {}),
    };

    if (decision.level === 'LIMITED') {
      return {
        access,
        patient: {
          id: patient.id,
          fullName: fullName(patient),
          age: patient.birthDate ? ageOn(patient.birthDate) : null,
          isMinor: isMinor(patient.birthDate),
        },
        alerts,
        clinicalAlerts,
        supportData: { clinicalConsent: consent.state },
      };
    }
    return {
      access,
      patient: {
        id: patient.id,
        fullName: fullName(patient),
        birthDate: formatDateOnly(patient.birthDate),
        age: patient.birthDate ? ageOn(patient.birthDate) : null,
        isMinor: isMinor(patient.birthDate),
        sex: patient.sex,
        status: patient.status,
      },
      alerts,
      clinicalAlerts,
      clinicalConsent: { state: consent.state, grantedAt: consent.grantedAt },
      sections: {
        status: 'NOT_AVAILABLE',
        note: 'Antecedentes, alergias y alertas están en /clinical/history y /clinical/alerts; diagnósticos, evoluciones y odontograma llegan en incrementos posteriores.',
      },
    };
  }
}
