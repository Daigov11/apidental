/** Mayoría de edad en Perú: 18 años (la capacidad para consentir de menores: por validar). */
export const AGE_OF_MAJORITY = 18;

/** Fecha calendario "hoy" en America/Lima, como [año, mes, día]. */
export function limaToday(now: Date = new Date()): [number, number, number] {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return [get('year'), get('month'), get('day')];
}

/** Las fechas de nacimiento se guardan como DATE (medianoche UTC = fecha calendario). */
export function ageOn(birthDate: Date, at: Date = new Date()): number {
  const [y, m, d] = limaToday(at);
  let age = y - birthDate.getUTCFullYear();
  const monthDiff = m - (birthDate.getUTCMonth() + 1);
  if (monthDiff < 0 || (monthDiff === 0 && d < birthDate.getUTCDate())) age -= 1;
  return age;
}

export const isMinor = (birthDate: Date | null | undefined, at: Date = new Date()): boolean =>
  birthDate ? ageOn(birthDate, at) < AGE_OF_MAJORITY : false;

export const toDateOnly = (value: string): Date => new Date(`${value}T00:00:00.000Z`);
export const formatDateOnly = (date: Date | null): string | null => (date ? date.toISOString().slice(0, 10) : null);

/** true si la fecha (YYYY-MM-DD) es posterior a hoy en Lima. */
export function isFutureDate(value: string): boolean {
  const [y, m, d] = limaToday();
  return value > `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
