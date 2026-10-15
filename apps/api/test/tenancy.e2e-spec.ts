import { bearer, createTestContext, Fixtures, loginInContext, uniq, type TestContext } from './helpers/app.js';

describe('Aislamiento por clínica y sede, y permisos', () => {
  let ctx: TestContext;
  let fx: Fixtures;
  beforeAll(async () => {
    ctx = await createTestContext();
    fx = new Fixtures(ctx.db);
  });
  afterAll(() => ctx.close());

  /** Dos clínicas con dos sedes cada una y un administrador por clínica. */
  async function twoClinics() {
    const a = await fx.clinic();
    const b = await fx.clinic();
    const a1 = await fx.branch(a.id);
    const a2 = await fx.branch(a.id);
    const b1 = await fx.branch(b.id);
    const adminA = (await fx.userWithRole('CLINIC_ADMIN', { clinicId: a.id })).user;
    const adminB = (await fx.userWithRole('CLINIC_ADMIN', { clinicId: b.id })).user;
    return { a, b, a1, a2, b1, adminA, adminB };
  }

  it('un administrador de clínica solo ve su clínica y sus sedes', async () => {
    const t = await twoClinics();
    const token = await loginInContext(ctx, t.adminA.email, { clinicId: t.a.id });

    const clinics = await ctx.http().get('/v1/clinics').set(bearer(token)).expect(200);
    expect(clinics.body.map((c: { id: string }) => c.id)).toEqual([t.a.id]);

    const branches = await ctx.http().get('/v1/branches').set(bearer(token)).expect(200);
    expect(branches.body.map((b: { id: string }) => b.id).sort()).toEqual([t.a1.id, t.a2.id].sort());
  });

  it('el parámetro clinicId de la consulta no permite ver otra clínica', async () => {
    const t = await twoClinics();
    const token = await loginInContext(ctx, t.adminA.email, { clinicId: t.a.id });
    const res = await ctx.http().get(`/v1/branches?clinicId=${t.b.id}`).set(bearer(token)).expect(200);
    expect(res.body.every((b: { clinicId: string }) => b.clinicId === t.a.id)).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain(t.b1.id);
  });

  it('un usuario con asignación a una sola sede solo ve esa sede', async () => {
    const t = await twoClinics();
    const { user } = await fx.userWithRole('RECEPTIONIST', { clinicId: t.a.id, branchId: t.a1.id });
    const token = await loginInContext(ctx, user.email, { clinicId: t.a.id, branchId: t.a1.id });
    const res = await ctx.http().get('/v1/branches').set(bearer(token)).expect(200);
    expect(res.body.map((b: { id: string }) => b.id)).toEqual([t.a1.id]);
  });

  it('una asignación de toda la clínica permite operar también en contexto de sede', async () => {
    const t = await twoClinics();
    const token = await loginInContext(ctx, t.adminA.email, { clinicId: t.a.id, branchId: t.a2.id });
    const res = await ctx.http().get('/v1/branches').set(bearer(token)).expect(200);
    expect(res.body.map((b: { id: string }) => b.id)).toEqual([t.a2.id]);
  });

  it('el administrador de plataforma ve todas las clínicas y puede filtrar sedes', async () => {
    const t = await twoClinics();
    const { user } = await fx.userWithRole('PLATFORM_ADMIN');
    const token = await loginInContext(ctx, user.email);
    // La base de pruebas acumula muchas clínicas: se recorren todas las páginas.
    const ids: string[] = [];
    for (let offset = 0; ; offset += 100) {
      const page = await ctx.http().get(`/v1/clinics?limit=100&offset=${offset}`).set(bearer(token)).expect(200);
      ids.push(...page.body.map((c: { id: string }) => c.id));
      if (page.body.length < 100) break;
    }
    expect(ids).toEqual(expect.arrayContaining([t.a.id, t.b.id]));
    const branches = await ctx.http().get(`/v1/branches?clinicId=${t.b.id}`).set(bearer(token)).expect(200);
    expect(branches.body.map((b: { id: string }) => b.id)).toEqual([t.b1.id]);
  });

  it('un rol sin permiso recibe 403 en una ruta administrativa', async () => {
    const t = await twoClinics();
    const { user } = await fx.userWithRole('RECEPTIONIST', { clinicId: t.a.id });
    const token = await loginInContext(ctx, user.email, { clinicId: t.a.id });
    await ctx.http().get('/v1/branches').set(bearer(token)).expect(200); // branch:read sí
    await ctx.http().post('/v1/branches').set(bearer(token)).send({ name: uniq('Sede ') }).expect(403);
    await ctx.http().get('/v1/users').set(bearer(token)).expect(403);
    await ctx.http().post('/v1/invitations').set(bearer(token)).send({ email: 'x@test.pe', roleCode: 'DENTIST' }).expect(403);
    await ctx.http().get('/v1/audit-logs').set(bearer(token)).expect(403);
  });

  it('crear clínicas es exclusivo de la plataforma', async () => {
    const t = await twoClinics();
    const adminToken = await loginInContext(ctx, t.adminA.email, { clinicId: t.a.id });
    await ctx.http().post('/v1/clinics').set(bearer(adminToken)).send({ name: 'Nueva' }).expect(403);

    const { user } = await fx.userWithRole('PLATFORM_ADMIN');
    const token = await loginInContext(ctx, user.email);
    const res = await ctx.http().post('/v1/clinics').set(bearer(token)).send({
      name: uniq('Clinica Nueva '),
      ruc: String(Math.floor(1e10 + Math.random() * 9e10)),
      brandPrimaryColor: '#0e7490',
    }).expect(201);
    expect(res.body).toMatchObject({ status: 'ACTIVE', brandPrimaryColor: '#0e7490' });
    const log = await ctx.db.auditLog.findFirst({ where: { action: 'CLINIC_CREATED', entityId: res.body.id } });
    expect(log?.userId).toBe(user.id);
  });

  it('valida RUC, color y URL del branding, y rechaza RUC duplicado', async () => {
    const { user } = await fx.userWithRole('PLATFORM_ADMIN');
    const token = await loginInContext(ctx, user.email);
    const post = (body: object) => ctx.http().post('/v1/clinics').set(bearer(token)).send(body);
    await post({ name: 'X1', ruc: '123' }).expect(400);
    await post({ name: 'X2', brandPrimaryColor: 'rojo' }).expect(400);
    await post({ name: 'X3', brandLogoUrl: 'http://inseguro.pe/logo.png' }).expect(400);
    const ruc = String(Math.floor(1e10 + Math.random() * 9e10));
    await post({ name: uniq('Dup '), ruc }).expect(201);
    await post({ name: uniq('Dup '), ruc }).expect(409);
  });

  it('el administrador de clínica crea sedes solo en su clínica', async () => {
    const t = await twoClinics();
    const token = await loginInContext(ctx, t.adminA.email, { clinicId: t.a.id });
    const name = uniq('Sede Nueva ');
    const res = await ctx.http().post('/v1/branches').set(bearer(token)).send({ name }).expect(201);
    expect(res.body.clinicId).toBe(t.a.id);
    await ctx.http().post('/v1/branches').set(bearer(token)).send({ name }).expect(409);
    await ctx.http().post('/v1/branches').set(bearer(token)).send({ name: uniq('S'), clinicId: t.b.id }).expect(403);
  });

  it('un contexto limitado a una sede no puede crear sedes', async () => {
    const t = await twoClinics();
    const admin = (await fx.userWithRole('CLINIC_ADMIN', { clinicId: t.a.id, branchId: t.a1.id })).user;
    const token = await loginInContext(ctx, admin.email, { clinicId: t.a.id, branchId: t.a1.id });
    await ctx.http().post('/v1/branches').set(bearer(token)).send({ name: uniq('S') }).expect(403);
  });

  it('la plataforma debe indicar la clínica al crear una sede', async () => {
    const t = await twoClinics();
    const { user } = await fx.userWithRole('PLATFORM_ADMIN');
    const token = await loginInContext(ctx, user.email);
    await ctx.http().post('/v1/branches').set(bearer(token)).send({ name: uniq('S') }).expect(400);
    await ctx.http().post('/v1/branches').set(bearer(token)).send({ name: uniq('S'), clinicId: t.b.id }).expect(201);
  });

  it('la paginación está acotada', async () => {
    const t = await twoClinics();
    const token = await loginInContext(ctx, t.adminA.email, { clinicId: t.a.id });
    await ctx.http().get('/v1/branches?limit=1000').set(bearer(token)).expect(400);
    const res = await ctx.http().get('/v1/branches?limit=1').set(bearer(token)).expect(200);
    expect(res.body).toHaveLength(1);
  });
});
