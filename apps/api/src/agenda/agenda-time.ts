import { BadRequestException } from '@nestjs/common';

/** Resolución de la agenda: todo se ocupa en huecos de 5 minutos. */
export const SLOT_MINUTES = 5;
export const SLOT_MS = SLOT_MINUTES * 60_000;
/** Paso con que se ofrecen horarios disponibles. */
export const OFFER_STEP_MINUTES = 15;
export const MAX_DURATION_MINUTES = 480;
/** Lima no tiene horario de verano: UTC-5 todo el año. */
const LIMA_OFFSET_MS = 5 * 3_600_000;

export const WEEKDAY_LABELS = ['', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'] as const;

/** 'YYYY-MM-DD' + minutos desde la medianoche (hora de Lima) → instante UTC. */
export function limaToUtc(date: string, minuteOfDay: number): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d, 0, minuteOfDay, 0, 0) + LIMA_OFFSET_MS);
}

/** Instante UTC → fecha y minuto del día en Lima, y día de la semana (1 = lunes … 7 = domingo). */
export function utcToLima(instant: Date): { date: string; minute: number; weekday: number } {
  const local = new Date(instant.getTime() - LIMA_OFFSET_MS);
  const date = local.toISOString().slice(0, 10);
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  const dow = local.getUTCDay();
  return { date, minute, weekday: dow === 0 ? 7 : dow };
}

export function weekdayOfDate(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === 0 ? 7 : dow;
}

export function isDateString(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export const addDays = (date: string, days: number): string => new Date(new Date(`${date}T00:00:00.000Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);

export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** 'HH:MM' → minutos. */
export function parseHm(value: string): number {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!m) throw new BadRequestException('La hora debe tener el formato HH:MM');
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  if (minutes % SLOT_MINUTES !== 0) throw new BadRequestException('La hora debe ser múltiplo de 5 minutos');
  return minutes;
}

export const formatHm = (minute: number): string => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

/** Instante ISO válido y alineado a 5 minutos (sin segundos). */
export function parseInstant(value: string, what = 'La fecha y hora'): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new BadRequestException(`${what} no es válida`);
  if (d.getTime() % SLOT_MS !== 0) throw new BadRequestException(`${what} debe ser múltiplo de ${SLOT_MINUTES} minutos`);
  return d;
}

/** Huecos de 5 minutos que cubre [start, end). */
export function slotStarts(start: Date, end: Date): Date[] {
  const out: Date[] = [];
  for (let t = start.getTime(); t < end.getTime(); t += SLOT_MS) out.push(new Date(t));
  return out;
}

export const addMinutes = (d: Date, minutes: number): Date => new Date(d.getTime() + minutes * 60_000);
