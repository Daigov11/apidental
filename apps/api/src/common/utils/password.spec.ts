import { getDummyHash, hashPassword, passwordNeedsRehash, verifyPassword } from './password.js';

describe('password (Argon2id)', () => {
  it('genera hashes Argon2id con sal distinta y los verifica', async () => {
    const a = await hashPassword('una-clave-segura-123');
    const b = await hashPassword('una-clave-segura-123');
    expect(a.startsWith('$argon2id$')).toBe(true);
    expect(a).not.toBe(b);
    expect(a).not.toContain('una-clave-segura-123');
    expect(await verifyPassword(a, 'una-clave-segura-123')).toBe(true);
    expect(await verifyPassword(a, 'otra-clave')).toBe(false);
  });

  it('un hash inválido nunca verifica (no lanza)', async () => {
    expect(await verifyPassword('no-es-un-hash', 'x')).toBe(false);
  });

  it('no pide rehash para hashes con los parámetros actuales', async () => {
    expect(passwordNeedsRehash(await hashPassword('abc123456789'))).toBe(false);
  });

  it('el hash de relleno es un hash válido y estable', async () => {
    expect(await getDummyHash()).toBe(await getDummyHash());
    expect(await verifyPassword(await getDummyHash(), 'cualquiera')).toBe(false);
  });
});
