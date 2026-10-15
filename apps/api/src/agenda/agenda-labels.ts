/** Textos de la agenda en lenguaje de la clínica (el panel muestra estos y no los códigos internos). */
export const APPOINTMENT_LABELS = {
  RESERVED: 'Reservado',
  CONFIRMED: 'Confirmado',
  ATTENDED: 'Atendido',
  CANCELLED: 'Cancelado',
  NO_SHOW: 'Ausente',
} as const;

export type AppointmentStatusCode = keyof typeof APPOINTMENT_LABELS;

/** Transiciones válidas (la base de datos impone las mismas). */
export const TRANSITIONS: Record<AppointmentStatusCode, readonly AppointmentStatusCode[]> = {
  RESERVED: ['CONFIRMED', 'ATTENDED', 'CANCELLED', 'NO_SHOW'],
  CONFIRMED: ['ATTENDED', 'CANCELLED', 'NO_SHOW'],
  ATTENDED: [],
  CANCELLED: [],
  NO_SHOW: [],
};

export const ACTIVE_STATUSES = ['RESERVED', 'CONFIRMED'] as const;
