/**
 * Puerto del proveedor de comprobantes. Hoy solo existe el simulador (`MockBillingProvider`); un adaptador real de
 * Apiworking implementaría esta misma interfaz sin cambiar los servicios. Los contratos reales están POR VALIDAR.
 */
export interface BillingEmitRequest {
  /** Misma clave = mismo comprobante: reenviarla nunca duplica la emisión. */
  idempotencyKey: string;
  clinicId: string;
  type: 'BOLETA' | 'FACTURA';
  series: string;
  number: number;
  customer: { docType: string; docNumber: string; name: string };
  amountCents: number;
  igvCents: number;
  currency: 'PEN';
  description: string;
  /** Número de intento (1, 2, …). */
  attempt: number;
  /** Solo el simulador lo usa para elegir la respuesta. Un proveedor real lo ignora. */
  scenario?: string | null;
}

export type BillingEmitResult =
  | { status: 'ISSUED'; providerRef: string; issuedAt: Date }
  | { status: 'PENDING'; providerRef?: string }
  | { status: 'REJECTED'; reason: string };

export interface BillingStatusResult {
  found: boolean;
  status?: 'ISSUED' | 'PENDING' | 'REJECTED';
  providerRef?: string;
  issuedAt?: Date;
  reason?: string;
}

/** Fallo temporal (red, 5xx, límite): se reintenta con la misma clave. */
export class ProviderTransientError extends Error {}
/** El proveedor no respondió a tiempo: puede haber procesado la solicitud. Hay que conciliar antes de reenviar. */
export class ProviderTimeoutError extends Error {}
export class IntegrationsDisabledError extends Error {}

export interface BillingProvider {
  readonly name: string;
  readonly simulated: boolean;
  emit(request: BillingEmitRequest): Promise<BillingEmitResult>;
  /** Consulta por clave de idempotencia (conciliación). */
  getStatus(idempotencyKey: string): Promise<BillingStatusResult>;
}
