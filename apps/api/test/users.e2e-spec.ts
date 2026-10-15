import { bearer, createTestContext, Fixtures, inviteAndAccept, inviteOk, inviteReq, login, loginInContext, PASSWORD, uniq, type TestContext } from './helpers/app.js';

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

  describe('alta de personal: solo por invitación (POST /v1/users ya no existe)', () => {
    it('no hay forma de crear usuarios con una contraseña fijada por el administrador', async () => {
      const t = await setup();
      const body = { email: `${uniq('x')}@test.pe`, password: 'Contraseña-Inicial-1', firstName: 'A', lastName: 'B', assignment: { roleCode: 'DENTIST' } };
      await ctx.http().post('/v1/users').set(bearer(t.tokenA)).send(body).expect(404);
      const { user } = await fx.userWithRole('PLATFORM_ADMIN');
      const platformToken = await loginInContext(ctx, user.email);
      await ctx.http().post('/v1/users').set(bearer(platformToken)).send(body).expect(404);
      expect(await ctx.db.user.count({ where: { email: body.email } })).toBe(0);
    });

    it('la persona invitada crea su propia cuenta y queda asignada a la clínica y sede del administrador', async () => {
      const t = await setup();
      const created = await inviteAndAccept(ctx, t.tokenA, { roleCode: 'DENTIST', branchId: t.a1.id });
      const token = await loginInContext(ctx, created.email, { clinicId: t.a.id, branchId: t.a1.id }, created.password);
      const me = await ctx.http().get('/v1/auth/me').set(bearer(token)).expect(200);
      expect(me.body.roles).toEqual(['DENTIST']);
      // la contraseña la eligió la persona: el administrador no la conoce (no hay ningún rastro de ella)
      const row = await ctx.db.user.findUniqueOrThrow({ where: { email: created.email }, omit: { passwordHash: false } });
      expect(row.passwordHash.startsWith('$argon2id$')).toBe(true);
    });

    it('rechaza invitar a roles de plataforma, a otra clínica, a sedes ajenas o a roles inexistentes', async () => {
      const t = await setup();
      const attempts: [number, Record<string, unknown>][] = [
        [403, { roleCode: 'PLATFORM_ADMIN' }],
        [403, { roleCode: 'DENTIST', clinicId: t.b.id }],
        [400, { roleCode: 'DENTIST', branchId: t.b1.id }],
        [400, { roleCode: 'ROL_INEXISTENTE' }],
        [400, { roleCode: 'CLINICAL_DIRECTOR' }], // sin registro formal de aprovisionamiento ni reautenticación
      ];
      const before = await ctx.db.invitation.count();
      for (const [status, body] of attempts) {
        const res = await inviteReq(ctx, t.tokenA, { email: `${uniq('x')}@test.pe`, ...body });
        expect(res.status, JSON.stringify(body)).toBe(status);
      }
      expect(await ctx.db.invitation.count()).toBe(before);
    });

    it('un administrador limitado a una sede solo invita a esa sede', async () => {
      const t = await setup();
      const branchAdmin = (await fx.userWithRole('CLINIC_ADMIN', { clinicId: t.a.id, branchId: t.a1.id })).user;
      const token = await loginInContext(ctx, branchAdmin.email, { clinicId: t.a.id, branchId: t.a1.id });
      await inviteReq(ctx, token, { email: `${uniq('x')}@test.pe`, roleCode: 'CASHIER', branchId: t.a2.id }).expect(403);
      const ok = await inviteReq(ctx, token, { email: `${uniq('x')}@test.pe`, roleCode: 'CASHIER' }).expect(201);
      expect(ok.body.branchId).toBe(t.a1.id);
    });

    it('la plataforma NO otorga roles de clínica directamente (la excepción del incremento 2 se retiró)', async () => {
      const t = await setup();
      const { user } = await fx.userWithRole('PLATFORM_ADMIN');
      const platformToken = await loginInContext(ctx, user.email);
      const target = await fx.user();
      for (const roleCode of ['CLINIC_ADMIN', 'DENTIST', 'RECEPTIONIST']) {
        const res = await ctx.http().post('/v1/assignments').set(bearer(platformToken)).send({ userId: target.id, roleCode, clinicId: t.b.id }).expect(403);
        expect(res.body.message).toMatch(/plataforma no otorga roles de clínica/);
      }
      expect(await ctx.db.userAssignment.count({ where: { userId: target.id } })).toBe(0);
    });

    it('el rol Director Clínico no se otorga por asignación directa, ni siquiera un administrador de clínica', async () => {
      const t = await setup();
      const target = await fx.user();
      const res = await ctx.http().post('/v1/assignments').set(bearer(t.tokenA)).send({ userId: target.id, roleCode: 'CLINICAL_DIRECTOR' }).expect(403);
      expect(res.body.message).toMatch(/solo se otorga mediante invitación formal/);
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
      await inviteOk(ctx, t.tokenA, { email: `${uniq('a')}@test.pe`, roleCode: 'ASSISTANT' });
      await inviteOk(ctx, tokenB, { email: `${uniq('b')}@test.pe`, roleCode: 'ASSISTANT' });

      const a = await ctx.http().get('/v1/audit-logs?limit=100').set(bearer(t.tokenA)).expect(200);
      expect(a.body.length).toBeGreaterThan(0);
      expect(a.body.every((l: { clinicId: string }) => l.clinicId === t.a.id)).toBe(true);

      const { user } = await fx.userWithRole('PLATFORM_ADMIN');
      const pt = await loginInContext(ctx, user.email);
      const all = await ctx.http().get('/v1/audit-logs?limit=100&action=INVITATION_CREATED').set(bearer(pt)).expect(200);
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
