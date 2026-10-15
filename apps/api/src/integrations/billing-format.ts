import { DEMO_MARK } from './integrations.constants.js';

export const money = (cents: number): string => `S/ ${(cents / 100).toFixed(2)}`;
/** IGV 18 % incluido en el total (regla de demostración). */
export const igvOf = (totalCents: number): number => totalCents - Math.round(totalCents / 1.18);

export const CHARGE_LABELS = { PENDING: 'Pendiente de pago', PAID: 'Pagado', VOIDED: 'Anulado' } as const;
export const METHOD_LABELS = { CASH: 'Efectivo', CARD: 'Tarjeta', YAPE_PLIN: 'Yape / Plin', TRANSFER: 'Transferencia' } as const;
export const DOC_LABELS = {
  PENDING_SEND: 'Pendiente de envío', SENT: 'Enviado', ISSUED: 'Emitido', REJECTED: 'Rechazado',
  RETRYABLE_ERROR: 'Error reintentable', NEEDS_RECONCILIATION: 'Requiere conciliación',
} as const;
export const TYPE_LABELS = { BOLETA: 'Boleta de venta (simulada)', FACTURA: 'Factura (simulada)' } as const;
export const OUTBOX_LABELS = { PENDING: 'En cola', DONE: 'Procesado', FAILED: 'Falló', SKIPPED: 'Omitido' } as const;
export const KIND_LABELS = { BILLING_EMIT: 'Emisión de comprobante', LOYALTY_ACCRUE: 'Puntos de fidelización', REVIEW_REQUEST: 'Solicitud de reseña' } as const;

export const docNumber = (series: string, number: number): string => `${series}-${String(number).padStart(8, '0')}`;
export { DEMO_MARK };
