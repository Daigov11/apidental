/** Soles con separador de miles: S/ 1,234.50. */
export const fmtMoney = (cents: number): string => `${cents < 0 ? '-' : ''}S/ ${(Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** «12», «12.5» o «12,50» → céntimos. Devuelve null si no es un monto válido (máximo 2 decimales). */
export function parseSoles(text: string): number | null {
  const t = text.trim().replace(/^S\/\s*/i, '').replace(',', '.');
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

export const centsToField = (cents: number): string => (cents / 100).toFixed(2);
