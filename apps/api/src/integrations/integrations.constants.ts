/** Marca obligatoria y visible de todo comprobante simulado (la base de datos también la exige con un CHECK). */
export const DEMO_MARK = 'DEMO — NO VÁLIDO PARA SUNAT';

/** Texto fijo que la interfaz muestra siempre que la información provenga de una simulación. */
export const SIMULATION_LABEL = 'SIMULACIÓN: datos ficticios de demostración. No hay conexión con Apiworking ni con SUNAT.';

export const simulationInfo = () => ({ active: true as const, label: SIMULATION_LABEL, demoMark: DEMO_MARK });

export const BILLING_PROVIDER = Symbol('BILLING_PROVIDER');
export const LOYALTY_PROVIDER = Symbol('LOYALTY_PROVIDER');
export const REVIEW_PROVIDER = Symbol('REVIEW_PROVIDER');

/** Puntos de fidelización de demostración: 1 punto por cada S/ 10 pagados (regla ficticia). */
export const POINTS_PER_CENTS = 1000;
