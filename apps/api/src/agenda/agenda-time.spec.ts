import { addDays, daysBetween, formatHm, limaToUtc, parseHm, parseInstant, slotStarts, utcToLima, weekdayOfDate } from './agenda-time.js';
import { ROLE_DEFINITIONS } from '../auth/permissions.js';

describe('agenda-time', () => {
  it('convierte entre Lima (UTC-5) y UTC', () => {
    expect(limaToUtc('2026-10-20', 600).toISOString()).toBe('2026-10-20T15:00:00.000Z');
    expect(utcToLima(new Date('2026-10-21T02:30:00.000Z'))).toEqual({ date: '2026-10-20', minute: 21 * 60 + 30, weekday: 2 });
  });
  it('día de la semana: 1 lunes … 7 domingo', () => {
    expect(weekdayOfDate('2026-10-19')).toBe(1);
    expect(weekdayOfDate('2026-10-25')).toBe(7);
  });
  it('fechas y rangos', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(daysBetween('2026-10-30', '2026-11-01')).toEqual(['2026-10-30', '2026-10-31', '2026-11-01']);
  });
  it('horas HH:MM múltiplos de 5 e instantes alineados', () => {
    expect(parseHm('08:05')).toBe(485);
    expect(formatHm(485)).toBe('08:05');
    expect(() => parseHm('8:00')).toThrow();
    expect(() => parseHm('08:03')).toThrow();
    expect(() => parseInstant('2026-10-20T15:01:00.000Z')).toThrow();
    expect(() => parseInstant('nada')).toThrow();
  });
  it('huecos de 5 minutos', () => {
    const s = new Date('2026-10-20T15:00:00.000Z');
    expect(slotStarts(s, new Date(s.getTime() + 30 * 60_000))).toHaveLength(6);
  });
});

describe('permisos de la agenda', () => {
  it('recepción gestiona citas pero no atiende; el odontólogo atiende pero no gestiona', () => {
    const has = (role: string, p: string) => (ROLE_DEFINITIONS.find((r) => r.code === role)?.permissions as readonly string[] | undefined)?.includes(p);
    expect(has('RECEPTIONIST', 'appointment:manage')).toBe(true);
    expect(has('RECEPTIONIST', 'appointment:attend')).toBe(false);
    expect(has('RECEPTIONIST', 'clinical:read')).toBe(false);
    expect(has('DENTIST', 'appointment:attend')).toBe(true);
    expect(has('DENTIST', 'appointment:manage')).toBe(false);
    expect(has('PLATFORM_ADMIN', 'appointment:read')).toBe(false);
  });
});
