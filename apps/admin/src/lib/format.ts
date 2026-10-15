/** Fechas y horas siempre en hora de Lima (UTC-5, sin horario de verano), sin importar la zona del navegador. */
const TZ = 'America/Lima';
const dateKey = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const hm = new Intl.DateTimeFormat('es-PE', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const longDay = new Intl.DateTimeFormat('es-PE', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' });
const shortDay = new Intl.DateTimeFormat('es-PE', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });
const dayMonthYear = new Intl.DateTimeFormat('es-PE', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' });

export const limaDate = (d: Date = new Date()): string => dateKey.format(d);
export const timeOf = (iso: string): string => hm.format(new Date(iso));
export const dayOf = (iso: string): string => dateKey.format(new Date(iso));
export const fmtLongDay = (date: string): string => capitalize(longDay.format(new Date(`${date}T12:00:00-05:00`)));
export const fmtShortDay = (date: string): string => capitalize(shortDay.format(new Date(`${date}T12:00:00-05:00`)));
export const fmtDate = (iso: string | null | undefined): string => (iso ? dayMonthYear.format(new Date(iso)) : '—');
export const fmtDateTime = (iso: string): string => `${fmtDate(iso)} ${timeOf(iso)}`;
export const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

export const addDays = (date: string, n: number): string => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** Lunes de la semana de `date`. */
export const mondayOf = (date: string): string => {
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
  return addDays(date, dow === 0 ? -6 : 1 - dow);
};
/** Minutos desde la medianoche (hora de Lima) de un instante ISO. */
export const minuteOfDay = (iso: string): number => {
  const [h, m] = hm.format(new Date(iso)).split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

export const mobileFmt = (v: string | null | undefined): string => (v ? v.replace(/^\+51/, '').replace(/(\d{3})(\d{3})(\d{3})/, '$1 $2 $3') : '—');
