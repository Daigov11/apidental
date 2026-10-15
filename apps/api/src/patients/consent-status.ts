import type { DbTx, PrismaDb } from '../prisma/client.js';

export type ClinicalConsentState = 'GRANTED' | 'REVOKED' | 'MISSING';

export interface ClinicalConsentStatus {
  state: ClinicalConsentState;
  grantedAt: Date | null;
}

export interface PatientAlert {
  code: 'CLINICAL_CONSENT_MISSING' | 'CLINICAL_CONSENT_REVOKED';
  severity: 'WARNING';
  message: string;
}

/**
 * Estado del consentimiento CLÍNICO del paciente. Su falta genera una alerta, pero NO bloquea crear al
 * paciente ni agendar. Los módulos de procedimientos (incrementos posteriores) usarán esta misma función
 * para bloquear solo los procedimientos configurados como "consentimiento obligatorio".
 */
export async function clinicalConsentStatus(
  db: DbTx | PrismaDb,
  clinicId: string,
  patientId: string,
): Promise<ClinicalConsentStatus> {
  const granted = await db.patientConsent.findFirst({
    where: { clinicId, patientId, type: 'CLINICAL', status: 'GRANTED' },
    orderBy: { grantedAt: 'desc' },
    select: { grantedAt: true },
  });
  if (granted) return { state: 'GRANTED', grantedAt: granted.grantedAt };
  const revoked = await db.patientConsent.count({ where: { clinicId, patientId, type: 'CLINICAL', status: 'REVOKED' } });
  return { state: revoked > 0 ? 'REVOKED' : 'MISSING', grantedAt: null };
}

export function consentAlerts(status: ClinicalConsentStatus): PatientAlert[] {
  if (status.state === 'GRANTED') return [];
  return [
    status.state === 'REVOKED'
      ? {
          code: 'CLINICAL_CONSENT_REVOKED',
          severity: 'WARNING',
          message: 'El consentimiento clínico del paciente fue revocado; los procedimientos que lo exijan quedarán bloqueados.',
        }
      : {
          code: 'CLINICAL_CONSENT_MISSING',
          severity: 'WARNING',
          message: 'Falta el consentimiento clínico del paciente; los procedimientos que lo exijan quedarán bloqueados.',
        },
  ];
}
