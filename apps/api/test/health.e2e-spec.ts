import { createTestContext, type TestContext } from './helpers/app.js';

describe('GET /v1/health', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(() => ctx.close());

  it('responde 200 sin autenticación e informa el estado de la base', async () => {
    const res = await ctx.http().get('/v1/health').expect(200);
    expect(res.body).toMatchObject({ status: 'ok', checks: { database: 'up' } });
    expect(Date.parse(res.body.timestamp)).not.toBeNaN();
  });

  it('no filtra datos sensibles ni tecnología del servidor', async () => {
    const res = await ctx.http().get('/v1/health').expect(200);
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(JSON.stringify(res.body)).not.toMatch(/mysql|password|secret/i);
  });

  it('respeta un X-Request-Id válido y descarta uno malicioso', async () => {
    const ok = await ctx.http().get('/v1/health').set('X-Request-Id', 'abc-12345678').expect(200);
    expect(ok.headers['x-request-id']).toBe('abc-12345678');
    const bad = await ctx.http().get('/v1/health').set('X-Request-Id', 'id con espacios <script>').expect(200);
    expect(bad.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rutas inexistentes devuelven el formato de error uniforme', async () => {
    const res = await ctx.http().get('/v1/no-existe').expect(404);
    expect(res.body).toMatchObject({ statusCode: 404, error: 'No encontrado' });
    expect(res.body.requestId).toBeTruthy();
  });

  it('CORS solo permite el origen configurado', async () => {
    const allowed = await ctx.http().get('/v1/health').set('Origin', 'http://localhost:5173');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    const denied = await ctx.http().get('/v1/health').set('Origin', 'https://evil.example');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });
});
