import { redact } from './redact.js';

describe('redact', () => {
  it('omite claves sensibles de forma recursiva, incluso dentro de arreglos', () => {
    const out = redact({
      email: 'a@b.pe',
      password: 'secreta',
      nested: { passwordHash: 'h', accessToken: 't', ok: 1 },
      list: [{ authorization: 'Bearer x', keep: true }],
    });
    expect(out).toEqual({
      email: 'a@b.pe',
      password: '[omitido]',
      nested: { passwordHash: '[omitido]', accessToken: '[omitido]', ok: 1 },
      list: [{ authorization: '[omitido]', keep: true }],
    });
  });

  it('conserva fechas y valores primitivos', () => {
    const d = new Date();
    expect(redact({ d, n: 1 })).toEqual({ d, n: 1 });
  });
});
