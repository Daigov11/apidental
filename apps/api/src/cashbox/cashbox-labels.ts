export const money = (cents: number): string => `${cents < 0 ? '-' : ''}S/ ${(Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const FLOW_LABELS = { INCOME: 'Ingreso', EXPENSE: 'Egreso' } as const;
export const KIND_LABELS = { NORMAL: '', OPENING: 'Saldo inicial / ajuste de apertura', COUNT_ADJUSTMENT: 'Ajuste por arqueo' } as const;
export const ACCOUNT_KIND_LABELS = { CASH: 'Efectivo', CARD: 'Tarjeta', YAPE_PLIN: 'Yape / Plin', TRANSFER: 'Transferencia', OTHER: 'Otro' } as const;

export const DEFAULT_ACCOUNTS = [
  { name: 'Efectivo', kind: 'CASH' },
  { name: 'Tarjeta', kind: 'CARD' },
  { name: 'Yape / Plin', kind: 'YAPE_PLIN' },
  { name: 'Transferencia', kind: 'TRANSFER' },
] as const;
export const DEFAULT_CATEGORIES = [
  { flow: 'INCOME', name: 'Cobro de atención' },
  { flow: 'INCOME', name: 'Venta de productos' },
  { flow: 'INCOME', name: 'Otros ingresos' },
  { flow: 'EXPENSE', name: 'Insumos y materiales' },
  { flow: 'EXPENSE', name: 'Servicios (luz, agua, internet)' },
  { flow: 'EXPENSE', name: 'Alquiler' },
  { flow: 'EXPENSE', name: 'Pago a proveedores' },
  { flow: 'EXPENSE', name: 'Sueldos y honorarios' },
  { flow: 'EXPENSE', name: 'Otros egresos' },
] as const;

/** Fecha "YYYY-MM-DD" de Lima (UTC-5, sin horario de verano) → instante de su medianoche. */
export const limaStart = (date: string): Date => new Date(`${date}T00:00:00-05:00`);
export const limaNextDay = (date: string): Date => new Date(limaStart(date).getTime() + 86_400_000);
