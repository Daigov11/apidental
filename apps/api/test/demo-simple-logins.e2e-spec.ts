import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { bearer, createTestContext, Fixtures, loginInContext, type TestContext } from './helpers/app.js';

describe('Demos: cuentas con correo corto y clave 123456', () => {
  let ctx: TestContext;
  let fx: Fixtures;
  beforeAll(async () => {
    ctx = await createTestContext();
    fx = new Fixtures(ctx.db);
  });
  afterAll(() => ctx.close());

  const run = (env: Record<string, string | undefined> = {}) =>
    execFileSync('npx', ['tsx', 'prisma/demo-simple-logins.ts'], {
      cwd: join(__dirname, '..'),
      env: { ...process.env, DATABASE_URL: process.env['TEST_DATABASE_URL'], APIWORKING_AUTHZ_EXPECTED_DATABASE: '', ...env },
      encoding: 'utf8',
      stdio: 'pipe',
    });

  it('renombra las cuentas demo (conservan sus datos), crea admin@demo.pe y todas entran con 123456; es idempotente', async () => {
    // La base de pruebas es compartida: si otra prueba ya creó las cuentas demo (con citas), se reutilizan; si no, se crean.
    const findOrCreate = async (emails: string[]) => (await ctx.db.user.findFirst({ where: { email: { in: emails } } })) ?? (await fx.user({ email: emails[0] }));
    const cashier = await findOrCreate(['cajero.demo@apidental.test', 'cajero@demo.pe']);
    let clinicId = (await ctx.db.userAssignment.findFirst({ where: { userId: cashier.id, clinicId: { not: null } } }))?.clinicId ?? null;
    if (!clinicId) {
      clinicId = (await fx.clinic()).id;
      await fx.assign(cashier.id, 'CASHIER', { clinicId });
    }
    const clinic = { id: clinicId };
    const dentist = await findOrCreate(['odontologa.demo@apidental.test', 'odontologo@demo.pe']);
    if (!(await ctx.db.userAssignment.findFirst({ where: { userId: dentist.id, clinicId, status: 'ACTIVE' } }))) await fx.assign(dentist.id, 'DENTIST', { clinicId });

    const out = run();
    expect(out).toContain('cajero@demo.pe');
    expect(out).toContain('admin@demo.pe');
    // Misma persona (mismo id): conserva sus datos.
    expect((await ctx.db.user.findUniqueOrThrow({ where: { email: 'cajero@demo.pe' } })).id).toBe(cashier.id);
    expect((await ctx.db.user.findUniqueOrThrow({ where: { email: 'odontologo@demo.pe' } })).id).toBe(dentist.id);
    for (const email of ['cajero@demo.pe', 'odontologo@demo.pe', 'admin@demo.pe']) {
      const token = await loginInContext(ctx, email, { clinicId: clinic.id }, '123456');
      expect((await ctx.http().get('/v1/auth/me').set(bearer(token)).expect(200)).body.roles.length).toBeGreaterThan(0);
    }
    // Idempotente.
    run();
    expect(await ctx.db.user.count({ where: { email: 'admin@demo.pe' } })).toBe(1);
  });

  it('se niega a correr en una instalación con Apiworking', () => {
    expect(() => run({ APIWORKING_AUTHZ_EXPECTED_DATABASE: 'prod_ti_x' })).toThrow(/Apiworking/);
  });
});
