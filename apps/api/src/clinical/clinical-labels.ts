/**
 * Textos en lenguaje de la clínica para la ficha de atención: el panel muestra estas etiquetas y no los nombres
 * técnicos internos. Se devuelven en cada ficha para que la pantalla no necesite su propio diccionario.
 */
export const CLINICAL_LABELS = {
  visit: { OPEN: 'Abierta', CLOSED: 'Cerrada', CANCELLED: 'Cancelada' },
  note: {
    DRAFT: 'Borrador',
    CLOSED: 'Cerrada',
    CORRECTED: 'Corregida',
    DISCARDED: 'Descartada',
    ENTERED_IN_ERROR: 'Registrada por error',
  },
  procedure: {
    OPEN: 'En curso',
    CLOSED: 'Realizado',
    CANCELLED: 'Cancelado',
    ENTERED_IN_ERROR: 'Registrado por error',
  },
  diagnosis: {
    ACTIVE: 'Vigente',
    INACTIVE: 'Ya no aplica',
    ENTERED_IN_ERROR: 'Registrado por error',
  },
  certainty: { PRESUMPTIVE: 'Presuntivo', DEFINITIVE: 'Definitivo' },
  alertSeverity: {
    INFO: 'Información',
    WARNING: 'Atención',
    CRITICAL: 'Importante',
  },
  alertOrigin: {
    ALLERGY: 'Alergia',
    BACKGROUND: 'Antecedente',
    MANUAL: 'Aviso',
  },
  allergyAssessment: {
    NOT_ASKED: 'Aún no se preguntó por alergias',
    NO_KNOWN_ALLERGIES: 'Sin alergias conocidas',
    ALLERGIES_RECORDED: 'Tiene alergias registradas',
  },
  consent: {
    GRANTED: 'Consentimiento clínico vigente',
    MISSING: 'Falta el consentimiento clínico',
    REVOKED: 'Consentimiento clínico revocado',
  },
} as const;

export const SHEET_NOTICE =
  'Los registros de esta ficha son declaraciones del profesional. El sistema no recomienda, no decide ni bloquea tratamientos por su contenido.';
