import { bearer, createTestContext, Fixtures, login, loginInContext, PASSWORD, uniq, type TestContext } from './helpers/app.js';

describe('Usuarios, roles y asignaciones', () => {
  let ctx: TestContext;
  let fx: Fixtures;
  beforeAll(async () => {
    ctx = await createTestContext();
    fx = new Fixtures(ctx.db);
  });
  afterAll(() => ctx.close());

  async function setup() {
    const a = await fx.clinic();
    const b = await fx.clinic();
    const a1 = await fx.branch(a.id);
    const a2 = await fx.branch(a.id);
    const b1 = await fx.branch(b.id);
    const adminA = (await fx.userWithRole('CLINIC_ADMIN', { clinicId: a.id })).user;
    const tokenA = await loginInContext(ctx, adminA.email, { clinicId: a.id });
    return { a, b, a1, a2, b1, adminA, tokenA };
  }
  const newUser = (extra: object = {}) => ({
    email: `${uniq('nuevo')}@test.pe`,
    password: 'Contraseña-Inicial-1',
    firstName: 'Ana',
    lastName: 'Pérez',
    ...extra,
  });

  describe('POST /v1/users', () => {
    it('crea un usuario con su asignación en la clínica del administrador y audita sin secretos', async () => {
      const t = await setup();
      const body = newUser({ assignment: { roleCode: 'DENTIST', branchId: t.a1.id } });
      const res = await ctx.http().post('/v1/users').set(bearer(t.tokenA)).send(body).expect(201);

      expect(res.body).toMatchObject({ email: body.email, status: 'ACTIVE', assignment: { clinicId: t.a.id, branchId: t.a1.id, role: { code: 'DENTIST' } } });
      expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|\$argon2|Contraseña-Inicial/);

      const logs = await ctx.db.auditLog.findMany({ where: { entityId: res.body.id } });
      expect(logs.map((l) => l.action)).toContain('USER_CREATED');
      expect(JSON.stringify(logs)).not.toMatch(/Contraseña-Inicial|argon2/);

      // el usuario creado puede iniciar sesión con la contraseña que se le asignó
      const real = await ctx.http().post('/v1/auth/login').send({ email: body.email, password: body.password }).expect(200);
      expect(real.body.contexts).toHaveLength(1);
    });

    it('un administrador de clínica debe asignar al usuario (no deja usuarios huérfanos)', async () => {
      const t = await setup();
      await ctx.http().post('/v1/users').set(bearer(t.tokenA)).send(newUser()).expect(400);
    });

    it('rechaza correo duplicado, contraseña corta y campos desconocidos', async () => {
      const t = await setup();
      const body = newUser({ assignment: { roleCode: 'ASSISTANT' } });
      await ctx.http().post('/v1/users').set(bearer(t.tokenA)).send(body).expect(201);
      await ctx.http().post('/v1/users').set(bearer(t.tokenA)).send(body).expect(409);
      await ctx.http().post('/v1/users').set(bearer(t.tokenA)).send(newUser({ password: 'corta', assignment: { roleCode: 'ASSISTANT' } })).expect(400);
      await ctx.http().post('/v1/users').set(bearer(t.tokenA)).send(newUser({ isAdmin: true, assignment: { roleCode: 'ASSISTANT' } })).expect(400);
    });

    it('no permite crear administradores de plataforma ni asignar en otra clínica ni con sede ajena', async () => {
      const t = await setup();
      const emails: string[] = [];
      const post = (assignment: object) => {
        const body = newUser({ assignment });
        emails.push(body.email);
        return ctx.http().post('/v1/users').set(bearer(t.tokenA)).send(body);
      };
      await post({ roleCode: 'PLATFORM_ADMIN' }).expect(403);
      await post({ roleCode: 'DENTIST', clinicId: t.b.id }).expect(403);
      await post({ roleCode: 'DENTIST', branchId: t.b1.id }).expect(400);
      await post({ roleCode: 'ROL_INEXISTENTE' }).expect(400);
      // ninguno de los intentos fallidos dejó usuarios a medias
      expect(await ctx.db.user.count({ where: { email: { in: emails } } })).toBe(0);
    });

    it('un administrador limitado a una sede solo crea usuarios de esa sede', async () => {
      const t = await setup();
      const branchAdmin = (await fx.userWithRole('CLINIC_ADMIN', { clinicId: t.a.id, branchId: t.a1.id })).user;
      const token = await loginInContext(ctx, branchAdmin.email, { clinicId: t.a.id, branchId: t.a1.id });
      await ctx.http().post('/v1/users').set(bearer(token)).send(newUser({ assignment: { roleCode: 'CASHIER', branchId: t.a2.id } })).expect(403);
      const ok = await ctx.http().post('/v1/users').set(bearer(token)).send(newUser({ assignment: { roleCode: 'CASHIER' } })).expect(201);
      expect(ok.body.assignment.branchId).toBe(t.a1.id);
    });

    it('la plataforma crea administradores de plataforma y de cualquier clínica', async () => {
      const t = await setup();
      const { user } = await fx.userWithRole('PLATFORM_ADMIN');
      const token = await loginInContext(ctx, user.email);
      const post = (body: object) => ctx.http().post('/v1/users').set(bearer(token)).send(body);
      const platform = await post(newUser({ assignment: { roleCode: 'PLATFORM_ADMIN' } })).expect(201);
      expect(platform.body.assignment).toMatchObject({ clinicId: null, branchId: null });
      await post(newUser({ assignment: { roleCode: 'PLATFORM_ADMIN', clinicId: t.a.id } })).expect(400);
      await post(newUser({ assignment: { roleCode: 'CLINIC_ADMIN' } })).expect(400); // falta clinicId
      const clinicAdmin = await post(newUser({ assignment: { roleCode: 'CLINIC_ADMIN', clinicId: t.b.id } })).expect(201);
      expect(clinicAdmin.body.assignment.clinicId).toBe(t.b.id);
    });
  });

  describe('GET /v1/users y /v1/roles', () => {
    it('lista únicamente usuarios de la clínica y solo asignaciones dentro del alcance', async () => {
      const t = await setup();
      const mine = (await fx.userWithRole('DENTIST', { clinicId: t.a.id, branchId: t.a1.id })).user;
      const foreign = (await fx.userWithRole('DENTIST', { clinicId: t.b.id })).user;
      // usuario compartido: trabaja en ambas clínicas
      const shared = await fx.user();
      await fx.assign(shared.id, 'DENTIST', { clinicId: t.a.id });
      await fx.assign(shared.id, 'DENTIST', { clinicId: t.b.id });

      const res = await ctx.http().get('/v1/users?limit=100').set(bearer(t.tokenA)).expect(200);
      const ids = res.body.map((u: { id: string }) => u.id);
      expect(ids).toEqual(expect.arrayContaining([mine.id, shared.id, t.adminA.id]));
      expect(ids).not.toContain(foreign.id);

      const sharedRow = res.body.find((u: { id: string }) => u.id === shared.id);
      expect(sharedRow.assignments).toHaveLength(1); // no revela su asignación en la otra clínica
      expect(sharedRow.assignments[0].clinicId).toBe(t.a.id);
      expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|\$argon2/);
    });

    it('la lista de roles oculta los roles de plataforma a las clínicas', async () => {
      const t = await setup();
      const res = await ctx.http().get('/v1/roles').set(bearer(t.tokenA)).expect(200);
      const codes = res.body.map((r: { code: string }) => r.code);
      expect(codes).not.toContain('PLATFORM_ADMIN');
      expect(codes).toEqual(expect.arrayContaining(['CLINIC_ADMIN', 'DENTIST', 'RECEPTIONIST', 'CASHIER', 'ASSISTANT']));

      const { user } = await fx.userWithRole('PLATFORM_ADMIN');
      const platformToken = await loginInContext(ctx, user.email);
      const all = await ctx.http().get('/v1/roles').set(bearer(platformToken)).expect(200);
      expect(all.body.map((r: { code: string }) => r.code)).toContain('PLATFORM_ADMIN');
    });
  });

  describe('POST /v1/assignments', () => {
    it('asigna un rol adicional y rechaza duplicados', async () => {
      const t = await setup();
      const user = await fx.user();
      const body = { userId: user.id, roleCode: 'CASHIER', branchId: t.a2.id };
      const res = await ctx.http().post('/v1/assignments').set(bearer(t.tokenA)).send(body).expect(201);
      expect(res.body).toMatchObject({ userId: user.id, clinicId: t.a.id, branchId: t.a2.id, status: 'ACTIVE' });
      await ctx.http().post('/v1/assignments').set(bearer(t.tokenA)).send(body).expect(409);
      const log = await ctx.db.auditLog.findFirst({ where: { action: 'ASSIGNMENT_CREATED', entityId: res.body.id } });
      expect(log).toMatchObject({ userId: t.adminA.id, clinicId: t.a.id, branchId: t.a2.id });
    });

    it('impide la escalada: ni roles de plataforma ni otra clínica ni usuarios inexistentes', async () => {
      const t = await setup();
      const user = await fx.user();
      const post = (body: object) => ctx.http().post('/v1/assignments').set(bearer(t.tokenA)).send(body);
      await post({ userId: user.id, roleCode: 'PLATFORM_ADMIN' }).expect(403);
      await post({ userId: user.id, roleCode: 'CLINIC_ADMIN', clinicId: t.b.id }).expect(403);
      await post({ userId: user.id, roleCode: 'DENTIST', branchId: t.b1.id }).expect(400);
      await post({ userId: '8e5f2c5a-7d3e-4f52-9d7c-3b7a1e9d6c11', roleCode: 'DENTIST' }).expect(404);
    });

    it('roles operativos no pueden administrar asignaciones', async () => {
      const t = await setup();
      const { user } = await fx.userWithRole('RECEPTIONIST', { clinicId: t.a.id });
      const token = await loginInContext(ctx, user.email, { clinicId: t.a.id });
      await ctx.http().post('/v1/assignments').set(bearer(token)).send({ userId: user.id, roleCode: 'CLINIC_ADMIN' }).expect(403);
    });
  });

  describe('PATCH /v1/assignments/:id/revoke', () => {
    it('revoca, quita el acceso del usuario y permite reactivar', async () => {
      const t = await setup();
      const { user, assignment } = await fx.userWithRole('DENTIST', { clinicId: t.a.id });
      const userToken = await loginInContext(ctx, user.email, { clinicId: t.a.id });
      await ctx.http().get('/v1/branches').set(bearer(userToken)).expect(200);

      const res = await ctx.http().patch(`/v1/assignments/${assignment.id}/revoke`).set(bearer(t.tokenA)).expect(200);
      expect(res.body.status).toBe('INACTIVE');
      await ctx.http().get('/v1/branches').set(bearer(userToken)).expect(403);
      expect(await ctx.db.auditLog.count({ where: { action: 'ASSIGNMENT_REVOKED', entityId: assignment.id } })).toBe(1);

      await ctx.http().patch(`/v1/assignments/${assignment.id}/revoke`).set(bearer(t.tokenA)).expect(200); // idempotente

      const again = await ctx.http().post('/v1/assignments').set(bearer(t.tokenA)).send({ userId: user.id, roleCode: 'DENTIST' }).expect(201);
      expect(again.body).toMatchObject({ id: assignment.id, status: 'ACTIVE' });
      expect(await ctx.db.auditLog.count({ where: { action: 'ASSIGNMENT_REACTIVATED', entityId: assignment.id } })).toBe(1);
    });

    it('no revela ni permite revocar asignaciones de otra clínica', async () => {
      const t = await setup();
      const { assignment } = await fx.userWithRole('DENTIST', { clinicId: t.b.id });
      await ctx.http().patch(`/v1/assignments/${assignment.id}/revoke`).set(bearer(t.tokenA)).expect(404);
      const still = await ctx.db.userAssignment.findUniqueOrThrow({ where: { id: assignment.id } });
      expect(still.status).toBe('ACTIVE');
    });

    it('no permite revocar asignaciones de plataforma ni las propias', async () => {
      const t = await setup();
      const platform = await fx.userWithRole('PLATFORM_ADMIN');
      await ctx.http().patch(`/v1/assignments/${platform.assignment.id}/revoke`).set(bearer(t.tokenA)).expect(404);
      const own = await ctx.db.userAssignment.findFirstOrThrow({ where: { userId: t.adminA.id } });
      await ctx.http().patch(`/v1/assignments/${own.id}/revoke`).set(bearer(t.tokenA)).expect(403);
      await ctx.http().patch('/v1/assignments/no-es-uuid/revoke').set(bearer(t.tokenA)).expect(400);
    });

    it('un administrador limitado a una sede no puede revocar asignaciones de otras sedes', async () => {
      const t = await setup();
      const branchAdmin = (await fx.userWithRole('CLINIC_ADMIN', { clinicId: t.a.id, branchId: t.a1.id })).user;
      const token = await loginInContext(ctx, branchAdmin.email, { clinicId: t.a.id, branchId: t.a1.id });
      const { assignment } = await fx.userWithRole('DENTIST', { clinicId: t.a.id, branchId: t.a2.id });
      await ctx.http().patch(`/v1/assignments/${assignment.id}/revoke`).set(bearer(token)).expect(404);
    });
  });

  describe('GET /v1/audit-logs', () => {
    it('cada clínica ve solo su propia auditoría; la plataforma ve todo', async () => {
      const t = await setup();
      const adminB = (await fx.userWithRole('CLINIC_ADMIN', { clinicId: t.b.id })).user;
      const tokenB = await loginInContext(ctx, adminB.email, { clinicId: t.b.id });
      await ctx.http().post('/v1/users').set(bearer(t.tokenA)).send(newUser({ assignment: { roleCode: 'ASSISTANT' } })).expect(201);
      await ctx.http().post('/v1/users').set(bearer(tokenB)).send(newUser({ assignment: { roleCode: 'ASSISTANT' } })).expect(201);

      const a = await ctx.http().get('/v1/audit-logs?limit=100').set(bearer(t.tokenA)).expect(200);
      expect(a.body.length).toBeGreaterThan(0);
      expect(a.body.every((l: { clinicId: string }) => l.clinicId === t.a.id)).toBe(true);

      const { user } = await fx.userWithRole('PLATFORM_ADMIN');
      const pt = await loginInContext(ctx, user.email);
      const all = await ctx.http().get('/v1/audit-logs?limit=100&action=USER_CREATED').set(bearer(pt)).expect(200);
      const clinics = new Set(all.body.map((l: { clinicId: string }) => l.clinicId));
      expect(clinics.has(t.a.id) && clinics.has(t.b.id)).toBe(true);
    });
  });

  it('un token de otro usuario nunca hereda permisos (sin asignaciones no hay acceso)', async () => {
    const user = await fx.user();
    const token = await login(ctx, user.email, PASSWORD);
    await ctx.http().get('/v1/roles').set(bearer(token)).expect(403);
  });
});
