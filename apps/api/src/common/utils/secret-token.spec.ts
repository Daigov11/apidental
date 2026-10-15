import { generateToken, hashToken, looksLikeToken } from './secret-token.js';

describe('tokens opacos', () => {
  it('generan 256 bits de entropía con prefijo y formato estable', () => {
    const t = generateToken('rt');
    expect(t).toMatch(/^rt_[A-Za-z0-9_-]{43}$/);
    expect(new Set(Array.from({ length: 500 }, () => generateToken('rt'))).size).toBe(500);
  });

  it('el hash es SHA-256 hexadecimal determinista y distinto del token', () => {
    const t = generateToken('inv');
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(t)).toBe(hashToken(t));
    expect(hashToken(t)).not.toContain(t);
    expect(hashToken('a')).toBe('ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb');
  });

  it('looksLikeToken descarta basura antes de tocar la base de datos', () => {
    expect(looksLikeToken(generateToken('rt'), 'rt')).toBe(true);
    for (const bad of [undefined, null, 5, {}, '', 'rt_', 'rt_corto', generateToken('inv'), `rt_${'!'.repeat(43)}`, `${generateToken('rt')}x`]) {
      expect(looksLikeToken(bad, 'rt')).toBe(false);
    }
  });
});
