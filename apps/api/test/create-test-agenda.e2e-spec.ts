import { execFileSync } from 'node:child_process';
import { actorIn, bearer, createTestContext, Fixtures, type TestContext, uniq } from './helpers/app.js';

/** db:create-test-agenda: servicios, consultorios y 2 odontólogos de prueba que aparecen en la agenda y no pueden ingresar. */
describe('Agenda de prueba para clínicas reales', () => {
  let ctx: TestContext;
  let fx: Fixtures;
  beforeAll(async () => { ctx = await createTestContext(); fx = new Fixtures(ctx.db); });
  afterAll(async () => { await ctx.close(); });

  const run = (clinicId: string, branch: string) =>
    execFileSync('npx', ['tsx', 'prisma/create-test-agenda.ts', '--clinic', clinicId, '--domain', 'probando', '--branch', branch], { cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'test' }, encoding: 'utf8' });

  it('crea servicios, consultorios y odontólogos con horario, sin duplicar al repetirse', async () => {
    const clinic = await fx.clinic(uniq('Clínica Prueba '));
    const branch = await fx.branch(clinic.id, 'Sede principal');
    const admin = await actorIn(ctx, fx, 'CLINIC_ADMIN', { clinicId: clinic.id });
    expect(run(clinic.id, 'Sede principal')).toMatch(/Agenda de prueba/);
    expect(run(clinic.id, 'Sede principal')).toMatch(/ya existía/);

    const get = (p: string) => ctx.http().get(`/v1${p}`).set(bearer(admin.token)).expect(200);
    const services = (await get('/agenda/services')).body as { name: string; priceCents: number }[];
    expect(services.map((s) => s.name)).toEqual(expect.arrayContaining(['Limpieza dental (prueba)', 'Consulta y diagnóstico (prueba)']));
    expect(services).toHaveLength(5);
    const dentists = (await get(`/agenda/dentists?branchId=${branch.id}`)).body as { firstName: string }[];
    expect(dentists).toHaveLength(2);
    expect(await ctx.db.scheduleRule.count({ where: { clinicId: clinic.id } })).toBe(24); // 2 odontólogos x 6 días x 2 turnos
    expect(await ctx.db.room.count({ where: { clinicId: clinic.id } })).toBe(2);

    // No pueden ingresar: la contraseña es aleatoria y no se guarda.
    const login = await ctx.http().post('/v1/auth/login').send({ email: 'prueba.odontologo1@probando.invalid', password: 'cualquiera-123456' });
    expect(login.status).toBe(401);
  });
});
