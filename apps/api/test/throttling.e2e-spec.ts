import { createTestContext, Fixtures, PASSWORD, type TestContext } from './helpers/app.js';

// Se fija antes de crear la app: la configuración se lee al construirla.
process.env['LOGIN_RATE_LIMIT_PER_MINUTE'] = '4';

describe('Límite de solicitudes en el login', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(() => ctx.close());

  it('responde 429 al superar el límite por IP, incluso con la clave correcta', async () => {
    const user = await new Fixtures(ctx.db).user();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await ctx.http().post('/v1/auth/login').send({ email: user.email, password: PASSWORD });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 4)).toEqual([200, 200, 200, 200]);
    expect(statuses.slice(4)).toEqual([429, 429]);
  });

  it('la reautenticación, las invitaciones y la recuperación de contraseña comparten el límite estricto por IP del login', async () => {
    for (const path of ['/v1/auth/reauthenticate', '/v1/invitations/accept', '/v1/invitations/preview', '/v1/auth/password-recovery', '/v1/auth/password-recovery/validate', '/v1/auth/password-recovery/confirm']) {
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) statuses.push((await ctx.http().post(path).send({})).status);
      expect(statuses.slice(0, 4).every((s) => s !== 429), path).toBe(true);
      expect(statuses.slice(4), path).toEqual([429, 429]);
    }
  });

  it('el límite del login no afecta al resto de rutas', async () => {
    await ctx.http().get('/v1/health').expect(200);
  });
});
