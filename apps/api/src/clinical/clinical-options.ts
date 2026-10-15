/**
 * Valores SUGERIDOS para completar formularios. Son apoyo administrativo, NO una guía ni una clasificación
 * médica: no validan ni limitan lo que el profesional escribe (los campos son texto estructurado libre). Más adelante
 * cada clínica podrá configurar los suyos.
 */
export const CLINICAL_OPTIONS = {
  administrativeAidOnly: true,
  notice:
    'Valores sugeridos de apoyo administrativo. No constituyen una guía clínica ni limitan lo que el profesional registra.',
  entryKinds: ['BACKGROUND', 'ALLERGY'],
  severities: ['NOT_SPECIFIED', 'MILD', 'MODERATE', 'SEVERE'],
  alertSeverities: ['INFO', 'WARNING', 'CRITICAL'],
  sources: ['PATIENT', 'GUARDIAN', 'DOCUMENT', 'PROFESSIONAL', 'OTHER'],
  suggestedCategories: {
    BACKGROUND: [
      'Médico',
      'Quirúrgico',
      'Medicación',
      'Hábitos',
      'Dental',
      'Familiar',
      'Otro',
    ],
    ALLERGY: [
      'Medicamento',
      'Anestésico',
      'Látex',
      'Material',
      'Alimento',
      'Otro',
    ],
  },
  changeKinds: {
    CORRECTED: 'Corrige un error de registro',
    RECTIFIED: 'Actualiza o rectifica la información',
    DEACTIVATED: 'Deja de aplicar (se conserva el historial)',
    REACTIVATED: 'Vuelve a aplicar',
    MARKED_IN_ERROR: 'Se registró por error (se conserva el historial)',
  },
} as const;
