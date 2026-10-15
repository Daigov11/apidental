import { ageOn, isFutureDate, isMinor, limaToday, toDateOnly } from './lima-date.js';

describe('fechas en America/Lima', () => {
  it('usa la fecha de Lima aunque en UTC ya sea el día siguiente', () => {
    // 2026-03-01 02:00 UTC = 2026-02-28 21:00 en Lima (UTC-5)
    expect(limaToday(new Date('2026-03-01T02:00:00Z'))).toEqual([2026, 2, 28]);
    expect(limaToday(new Date('2026-03-01T06:00:00Z'))).toEqual([2026, 3, 1]);
  });

  it('calcula la edad exacta el día del cumpleaños', () => {
    const born = toDateOnly('2008-06-15');
    expect(ageOn(born, new Date('2026-06-15T12:00:00Z'))).toBe(18);
    expect(ageOn(born, new Date('2026-06-14T12:00:00Z'))).toBe(17);
  });

  it('determina menores de edad (18 años) y trata la fecha desconocida como no menor', () => {
    const now = new Date('2026-10-14T12:00:00Z');
    expect(isMinor(toDateOnly('2008-10-15'), now)).toBe(true);
    expect(isMinor(toDateOnly('2008-10-14'), now)).toBe(false);
    expect(isMinor(null)).toBe(false);
  });

  it('detecta fechas futuras', () => {
    expect(isFutureDate('2999-01-01')).toBe(true);
    expect(isFutureDate('2000-01-01')).toBe(false);
  });
});
