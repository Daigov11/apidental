import { afterEach } from 'vitest';
import { api, ApiError, setAccessToken } from '../src/api/client';
import { mockApi } from './helpers';

afterEach(() => vi.unstubAllGlobals());

describe('Cliente de la API', () => {
  it('varias solicitudes con 401 comparten UNA sola renovación y se reintentan con el token nuevo', async () => {
    setAccessToken('viejo');
    let renewed = false;
    const { called } = mockApi({
      'POST /auth/refresh': () => { renewed = true; return { json: { accessToken: 'nuevo' } }; },
      'GET /a': (c) => (c.headers['authorization'] === 'Bearer nuevo' ? { json: { ok: 'a' } } : { status: 401, json: {} }),
      'GET /b': (c) => (c.headers['authorization'] === 'Bearer nuevo' ? { json: { ok: 'b' } } : { status: 401, json: {} }),
    });
    const [a, b] = await Promise.all([api<{ ok: string }>('GET', '/a'), api<{ ok: string }>('GET', '/b')]);
    expect([a.ok, b.ok]).toEqual(['a', 'b']);
    expect(renewed).toBe(true);
    expect(called('POST', '/auth/refresh')).toHaveLength(1);
  });

  it('si la renovación falla avisa que la sesión terminó', async () => {
    setAccessToken('viejo');
    mockApi({ 'POST /auth/refresh': { status: 401, json: {} }, 'GET /a': { status: 401, json: {} } });
    const { onSessionLost } = await import('../src/api/client');
    const lost = vi.fn();
    onSessionLost(lost);
    await expect(api('GET', '/a')).rejects.toBeInstanceOf(ApiError);
    expect(lost).toHaveBeenCalledTimes(1);
    onSessionLost(null);
  });

  it('los errores 5xx y 429 se traducen a mensajes claros sin texto técnico', async () => {
    setAccessToken('t');
    mockApi({ 'GET /x': { status: 500, json: { message: 'SQL syntax error near ...' } }, 'GET /y': { status: 429, json: { message: 'ThrottlerException' } } });
    await expect(api('GET', '/x')).rejects.toMatchObject({ status: 500, message: expect.not.stringContaining('SQL') });
    await expect(api('GET', '/y')).rejects.toMatchObject({ status: 429, message: expect.stringContaining('Demasiados intentos') });
  });
});
