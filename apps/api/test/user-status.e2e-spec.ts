import {
  acceptReq,
  actorIn,
  bearer,
  createTestContext,
  Fixtures,
  inviteOk,
  loginFull,
  loginInContext,
  PASSWORD,
  reauthProofFor,
  recoveryReq,
  refreshWith,
  requestRecovery,
  sessionIdOf,
  settleRecoveries,
  type TestContext,
} from './helpers/app.js';

describe('Deshabilitación y reactivación de usuarios', () => {
  let ctx: TestContext;
  let fx: Fixtures;
  beforeAll(async () => {
    ctx = await createTestContext();
    fx = new Fixtures(ctx.db);
  });
  afterAll(() => ctx.close());

  const disable = (token: string, id: string, reason: object = { reason: 'Baja del personal' }) =>
    ctx.http().post(`/v1/users/${id}/disable`).set(bearer(token)).send(reason);
  const reactivate = (token: string, id: string, reason: object = { reason: 'Regresa a la clínica' }) =>
    ctx.http().post(`/v1/users/${id}/reactivate`).set(bearer(token)).send(reason);
  const statusOf = (id: string) => ctx.db.user.findUniqueOrThrow({ where: { id } }).then((u) => u.status);
  async function platform() {
    const { user } = await fx.userWithRole('PLATFORM_ADMIN');
    return { user, token: await loginInContext(ctx, user.email) };
  }

  describe('permisos y alcance', () => {
    it('el administrador deshabilita a un usuario de su clínica: no se elimina, se conserva todo y queda auditado', async () => {
      const clinic = await fx.clinic();
      const admin = await actorIn(ctx, fx, 'CLINIC_ADMIN', { clinicId: clinic.id });
      const { user, assignment } = await fx.userWithRole('DENTIST', { clinicId: clinic.id });
      await loginFull(ctx, user.email);
      const before = await ctx.db.auditLog.count({ where: { userId: user.id } });

      const res = await disable(admin.token, user.id, { reason: 'Terminó su contrato' }).expect(200);
      expect(res.body).toMatchObject({ id: user.id, status: 'DISABLED', sessionsRevoked: 1 });
      const row = await ctx.db.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(row).toMatchObject({ status: 'DISABLED', disabledById: admin.user.id, disabledReason: 'Terminó su contrato', disabledByPlatform: false });
      expect(row.disabledAt).toBeInstanceOf(Date);
      // no se elimina: la cuenta, su asignación y su auditoría histórica siguen ahí
      expect((await ctx.db.userAssignment.findUniqueOrThrow({ where: { id: assignment.id } })).status).toBe('ACTIVE');
      expect(await ctx.db.auditLog.count({ where: { userId: user.id } })).toBeGreaterThanOrEqual(before);
      const [log] = await ctx.db.auditLog.findMany({ where: { action: 'USER_DISABLED', entityId: user.id } });
      expect(log).toMatchObject({ userId: admin.user.id, clinicId: clinic.id });
      expect(log!.summary).toMatchObject({ reason: 'Terminó su contrato', byPlatform: false, sessionsRevoked: 1, authoritiesHeld: [] });
      expect(JSON.stringify(log)).not.toContain(user.email);
      // aparece en el listado con su estado
      const list = await ctx.http().get('/v1/users?limit=100').set(bearer(admin.token)).expect(200);
      expect(list.body.find((u: { id: string }) => u.id === user.id).status).toBe('DISABLED');
    });

    it('exige motivo, id válido y usuario existente; nunca la propia cuenta', async () => {
      const clinic = await fx.clinic();
      const admin = await actorIn(ctx, fx, 'CLINIC_ADMIN', { clinicId: clinic.id });
      const { user } = await fx.userWithRole('DENTIST', { clinicId: clinic.id });
      await disable(admin.token, user.id, {}).expect(400);
      await disable(admin.token, user.id, { reason: 'no' }).expect(400);
      await disable(admin.token, user.id, { reason: 'Motivo válido', userId: 'otro' }).expect(400);
      await disable(admin.token, 'no-es-uuid').expect(400);
      await disable(admin.token, '8e5f2c5a-7d3e-4f52-9d7c-3b7a1e9d6c11').expect(404);
      await disable(admin.token, admin.user.id).expect(403);
      expect(await statusOf(user.id)).toBe('ACTIVE');
      expect(await statusOf(admin.user.id)).toBe('ACTIVE');
    });

    it('solo quien tiene user:manage: el resto del personal y el Director reciben 403; sin JWT, 401', async () => {
      const clinic = await fx.clinic();
      const { user } = await fx.userWithRole('DENTIST', { clinicId: clinic.id });
      for (const role of ['RECEPTIONIST', 'DENTIST', 'CASHIER', 'ASSISTANT', 'CLINICAL_DIRECTOR']) {
        const actor = await actorIn(ctx, fx, role, { clinicId: clinic.id });
        await disable(actor.token, user.id).expect(403);
        await reactivate(actor.token, user.id).expect(403);
      }
      await ctx.http().post(`/v1/users/${user.id}/disable`).send({ reason: 'sin token' }).expect(401);
      expect(await statusOf(user.id)).toBe('ACTIVE');
    });

    it('un administrador no alcanza a usuarios de otra clínica (404 uniforme)', async () => {
      const a = await fx.clinic();
      const b = await fx.clinic();
      const adminA = await actorIn(ctx, fx, 'CLINIC_ADMIN', { clinicId: a.id });
      const { user: inB } = await fx.userWithRole('DENTIST', { clinicId: b.id });
      await disable(adminA.token, inB.id).expect(404);
      await reactivate(adminA.token, inB.id).expect(404);
      expect(await statusOf(inB.id)).toBe('ACTIVE');
    });

    it('una cuenta compartida con otra clínica no se deshabilita desde una clínica (se revoca su asignación); la plataforma sí puede', async () => {
      const a = await fx.clinic();
      const b = await fx.clinic();
      const adminA = await actorIn(ctx, fx, 'CLINIC_ADMIN', { clinicId: a.id });
      const shared = await fx.user();
      await fx.assign(shared.id, 'DENTIST', { clinicId: a.id });
      await fx.assign(shared.id, 'DENTIST', { clinicId: b.id });
      const res = await disable(adminA.token, shared.id).expect(409);
      expect(res.body.code).toBe('ACCOUNT_SHARED');
      expect(await statusOf(shared.id)).toBe('ACTIVE');
      const p = await platform();
      await disable(p.token, shared.id, { reason: 'Incidente de seguridad' }).expect(200);
      expect((await ctx.db.user.findUniqueOrThrow({ where: { id: shared.id } })).disabledByPlatform).toBe(true);
    });

    it('un administrador limitado a una sede solo gestiona a quien trabaja únicamente en ella', async () => {
      const clinic = await fx.clinic();
      const b1 = await fx.branch(clinic.id);
      const b2 = await fx.branch(clinic.id);
      const branchAdmin = await actorIn(ctx, fx, 'CLINIC_ADMIN', { clinicId: clinic.id, branchId: b1.id });
      const onlyHere = await fx.userWithRole('DENTIST', { clinicId: clinic.id, branchId: b1.id });
      const wholeClinic = await fx.userWithRole('DENTIST', { clinicId: clinic.id });
      const otherBranch = await fx.userWithRole('DENTIST', { clinicId: clinic.id, branchId: b2.id });
      await disable(branchAdmin.token, wholeClinic.user.id).expect(403);
      await disable(branchAdmin.token, otherBranch.user.id).expect(404);
      await disable(branchAdmin.token, onlyHere.user.id).expect(200);
    });

    it('ya deshabilitada: 409; la reactivación de una cuenta activa: 409', async () => {
      const clinic = await fx.clinic();
      const admin = await actorIn(ctx, fx, 'CLINIC_ADMIN', { clinicId: clinic.id });
      const { user } = await fx.userWithRole('DENTIST', { clinicId: clinic.id });
      await reactivate(admin.token, user.id).expect(409);
      await disable(admin.token, user.id).expect(200);
      await disable(admin.token, user.id).expect(409);
    });
  });

  describe('efectos inmediatos', () => {
    it('revoca sesiones y refresh tokens, impide nuevos accesos y deja inservibles las pruebas de reautenticación', async () => {
      const clinic = await fx.clinic();
      const admin = await actorIn(ctx, fx, 'CLINIC_ADMIN', { clinicId: clinic.id });
      const { user } = await fx.userWithRole('DENTIST', { clinicId: clinic.id });
      const s1 = await loginFull(ctx, user.email);
      const s2 = await loginFull(ctx, user.email);
      const proof = await reauthProofFor(ctx, s1.accessToken, 'CLOSE_CLINICAL_NOTE');
      await ctx.http().get('/v1/auth/me').set(bearer(s1.accessToken)).expect(200);

      await disable(admin.token, user.id).expect(200);

      // al instante: ni el access token ni el refresh token de ninguna sesión sirven
      for (const s of [s1, s2]) {
        await ctx.http().get('/v1/auth/me').set(bearer(s.accessToken)).expect(401);
        await refreshWith(ctx, s.refreshToken).expect(401);
      }
      const sessions = await ctx.db.authSession.findMany({ where: { userId: user.id } });
      expect(sessions.every((s) => s.revokedReason === 'USER_DISABLED' && s.revokedAt)).toBe(true);
      expect(await ctx.db.refreshToken.count({ where: { session: { userId: user.id }, status: 'ACTIVE' } })).toBe(0);
      expect((await ctx.db.reauthProof.findFirstOrThrow({ where: { userId: user.id } })).usedAt).toBeInstanceOf(Date);
      expect(proof).toBeTruthy();
      // no puede iniciar sesión (respuesta genérica) ni abrir una nueva sesión
      const login = await ctx.http().post('/v1/auth/login').send({ email: user.email, password: PASSWORD }).expect(401);
      expect(login.body.message).toBe('Credenciales inválidas');
      expect(await ctx.db.authSession.count({ where: { userId: user.id } })).toBe(2);
    });

    it('anula las recuperaciones pendientes y no emite nuevas; el resto de sesiones de otros usuarios no se toca', async () => {
      const clinic = await fx.clinic();
      const admin = await actorIn(ctx, fx, 'CLINIC_ADMIN', { clinicId: clinic.id });
      const { user } = await fx.userWithRole('DENTIST', { clinicId: clinic.id });
      const bystander = await loginFull(ctx, (await fx.userWithRole('DENTIST', { clinicId: clinic.id })).user.email);
      const token = await requestRecovery(ctx, user.email);
      await disable(admin.token, user.id).expect(200);
      const rec = await ctx.db.passwordRecovery.findFirstOrThrow({ where: { userId: user.id } });
      expect(rec).toMatchObject({ status: 'REVOKED', revokedReason: 'user_disabled', pendingKey: null });
      await ctx.http().post('/v1/auth/password-recovery/confirm').send({ token, newPassword: 'Clave-Nueva-Larga-2026' }).expect(404);
      await recoveryReq(ctx, user.email).expect(202);
      await settleRecoveries(ctx);
      expect(await ctx.db.passwordRecovery.count({ where: { userId: user.id } })).toBe(1); // no se creó otra
      await ctx.http().get('/v1/auth/me').set(bearer(bystander.accessToken)).expect(200);
    });

    it('una invitación dirigida a la cuenta o emitida por ella ya no se puede aceptar', async () => {
      const clinic = await fx.clinic();
      const admin = await actorIn(ctx, fx, 'CLINIC_ADMIN', { clinicId: clinic.id });
      const spare = await actorIn(ctx, fx, 'CLINIC_ADMIN', { clinicId: clinic.id });
      const inviter = await inviteOk(ctx, spare.token, { email: `${Date.now()}x@test.pe`, roleCode: 'ASSISTANT' });
      const toUser = await fx.user();
      const addressed = await inviteOk(ctx, admin.token, { email: toUser.email, roleCode: 'DENTIST' });
      await disable(admin.token, spare.user.id).expect(200);
      await acceptReq(ctx, inviter.token).expect(404); // quien invitó está deshabilitado
      await ctx.db.user.update({ where: { id: toUser.id }, data: { status: 'DISABLED' } });
      await acceptReq(ctx, addressed.token, { password: PASSWORD }).expect(404); // destinatario deshabilitado
    });
  });

  describe('reactivación', () => {
    it('es explícita y auditada, no restaura sesiones anteriores y exige iniciar sesión de nuevo', async () => {
      const clinic = await fx.clinic();
      const admin = await actorIn(ctx, fx, 'CLINIC_ADMIN', { clinicId: clinic.id });
      const { user, assignment } = await fx.userWithRole('DENTIST', { clinicId: clinic.id });
      const old = await loginFull(ctx, user.email);
      for (let i = 0; i < 3; i++) await ctx.http().post('/v1/auth/login').send({ email: `${user.email}`, password: `Mala-${i}-Clave-123` });
      await disable(admin.token, user.id).expect(200);

      const res = await reactivate(admin.token, user.id, { reason: 'Regresó de licencia' }).expect(200);
      expect(res.body).toEqual({ id: user.id, status: 'ACTIVE' });
      const row = await ctx.db.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(row).toMatchObject({ status: 'ACTIVE', disabledAt: null, disabledById: null, disabledReason: null, disabledByPlatform: false, failedLoginAttempts: 0, lockedUntil: null });
      expect((await ctx.db.userAssignment.findUniqueOrThrow({ where: { id: assignment.id } })).status).toBe('ACTIVE');

      // las sesiones de antes siguen revocadas: nada se restaura
      await ctx.http().get('/v1/auth/me').set(bearer(old.accessToken)).expect(401);
      await refreshWith(ctx, old.refreshToken).expect(401);
      expect((await ctx.db.authSession.findUniqueOrThrow({ where: { id: sessionIdOf(old.accessToken) } })).revokedReason).toBe('USER_DISABLED');
      const fresh = await loginFull(ctx, user.email);
      expect(sessionIdOf(fresh.accessToken)).not.toBe(sessionIdOf(old.accessToken));
      await ctx.http().get('/v1/auth/me').set(bearer(fresh.accessToken)).expect(200);

      const [log] = await ctx.db.auditLog.findMany({ where: { action: 'USER_REACTIVATED', entityId: user.id } });
      expect(log).toMatchObject({ userId: admin.user.id });
      expect(log!.summary).toEqual({ reason: 'Regresó de licencia', sessionsRestored: 0 });
    });

    it('exige motivo y alcance; una cuenta que deshabilitó la plataforma solo la reactiva la plataforma', async () => {
      const clinic = await fx.clinic();
      const admin = await actorIn(ctx, fx, 'CLINIC_ADMIN', { clinicId: clinic.id });
      const { user } = await fx.userWithRole('DENTIST', { clinicId: clinic.id });
      const p = await platform();
      await disable(p.token, user.id, { reason: 'Credenciales filtradas' }).expect(200);
      await reactivate(admin.token, user.id, {}).expect(400);
      const denied = await reactivate(admin.token, user.id).expect(403);
      expect(denied.body.message).toMatch(/solo la plataforma/);
      expect(await statusOf(user.id)).toBe('DISABLED');
      await reactivate(p.token, user.id).expect(200);
      expect(await statusOf(user.id)).toBe('ACTIVE');
    });
  });

  describe('regla de último administrador y último Director', () => {
    it('no se deshabilita al último administrador de la clínica: nada cambia y queda auditado', async () => {
      const clinic = await fx.clinic();
      const only = await fx.userWithRole('CLINIC_ADMIN', { clinicId: clinic.id });
      const session = await loginFull(ctx, only.user.email);
      const p = await platform();
      const res = await disable(p.token, only.user.id).expect(409);
      expect(res.body).toMatchObject({ code: 'LAST_AUTHORITY' });
      expect(res.body.message).toMatch(/último administrador de la clínica/);
      expect(await statusOf(only.user.id)).toBe('ACTIVE');
      await ctx.http().get('/v1/auth/me').set(bearer(session.accessToken)).expect(200); // su sesión no se tocó
      const [log] = await ctx.db.auditLog.findMany({ where: { action: 'LAST_AUTHORITY_BLOCKED', entityId: only.user.id } });
      expect(log!.summary).toEqual({ blockedOperation: 'disable_user' });
    });

    it('con dos administradores se puede deshabilitar a uno; el que queda ya no', async () => {
      const clinic = await fx.clinic();
      const a = await fx.userWithRole('CLINIC_ADMIN', { clinicId: clinic.id });
      const b = await fx.userWithRole('CLINIC_ADMIN', { clinicId: clinic.id });
      const p = await platform();
      await disable(p.token, a.user.id).expect(200);
      await disable(p.token, b.user.id).expect(409);
    });

    it('el administrador de una sola sede no cuenta como autoridad de la clínica', async () => {
      const clinic = await fx.clinic();
      const branch = await fx.branch(clinic.id);
      const whole = await fx.userWithRole('CLINIC_ADMIN', { clinicId: clinic.id });
      await fx.userWithRole('CLINIC_ADMIN', { clinicId: clinic.id, branchId: branch.id });
      await disable((await platform()).token, whole.user.id).expect(409);
    });

    it('no se deshabilita al último Director Clínico, aunque haya administrador', async () => {
      const clinic = await fx.clinic();
      await fx.userWithRole('CLINIC_ADMIN', { clinicId: clinic.id });
      const d1 = await fx.userWithRole('CLINICAL_DIRECTOR', { clinicId: clinic.id });
      const d2 = await fx.userWithRole('CLINICAL_DIRECTOR', { clinicId: clinic.id });
      const p = await platform();
      await disable(p.token, d1.user.id).expect(200);
      const res = await disable(p.token, d2.user.id).expect(409);
      expect(res.body.message).toMatch(/último Director Clínico/);
    });

    it('quien ejerce dos autoridades se evalúa por cada una y la operación es atómica', async () => {
      const clinic = await fx.clinic();
      const both = await fx.user();
      await fx.assign(both.id, 'CLINIC_ADMIN', { clinicId: clinic.id });
      await fx.assign(both.id, 'CLINICAL_DIRECTOR', { clinicId: clinic.id });
      await fx.userWithRole('CLINIC_ADMIN', { clinicId: clinic.id }); // hay relevo administrativo, NO clínico
      const session = await loginFull(ctx, both.email);
      const res = await disable((await platform()).token, both.id).expect(409);
      expect(res.body.message).toMatch(/Director Clínico/);
      expect(await statusOf(both.id)).toBe('ACTIVE');
      expect(await ctx.db.authSession.count({ where: { userId: both.id, revokedAt: null } })).toBe(1); // nada a medias
      await ctx.http().get('/v1/auth/me').set(bearer(session.accessToken)).expect(200);
    });

    it('quien no ejerce una autoridad protegida se deshabilita aunque la clínica tenga un solo administrador', async () => {
      const clinic = await fx.clinic();
      const admin = await actorIn(ctx, fx, 'CLINIC_ADMIN', { clinicId: clinic.id });
      const { user } = await fx.userWithRole('RECEPTIONIST', { clinicId: clinic.id });
      await disable(admin.token, user.id).expect(200);
    });
  });

  describe('concurrencia: nunca queda una clínica sin autoridad válida', () => {
    it('dos administradores que se deshabilitan a la vez: solo uno prospera', async () => {
      for (let round = 0; round < 3; round++) {
        const clinic = await fx.clinic();
        const a = await fx.userWithRole('CLINIC_ADMIN', { clinicId: clinic.id });
        const b = await fx.userWithRole('CLINIC_ADMIN', { clinicId: clinic.id });
        const [t1, t2] = [(await platform()).token, (await platform()).token];
        const results = await Promise.all([disable(t1, a.user.id), disable(t2, b.user.id)]);
        expect(results.map((r) => r.status).sort((x, y) => x - y), `ronda ${round}`).toEqual([200, 409]);
        expect(await ctx.db.userAssignment.count({ where: { clinicId: clinic.id, status: 'ACTIVE', role: { code: 'CLINIC_ADMIN' }, user: { status: 'ACTIVE' } } })).toBe(1);
      }
    });

    it('cuatro administradores deshabilitados a la vez: prosperan tres y siempre queda uno', async () => {
      const clinic = await fx.clinic();
      const admins = await Promise.all([1, 2, 3, 4].map(() => fx.userWithRole('CLINIC_ADMIN', { clinicId: clinic.id })));
      const tokens = await Promise.all(admins.map(() => platform().then((p) => p.token)));
      const results = await Promise.all(admins.map((a, i) => disable(tokens[i]!, a.user.id)));
      expect(results.filter((r) => r.status === 200)).toHaveLength(3);
      expect(results.filter((r) => r.status === 409)).toHaveLength(1);
      expect(await ctx.db.userAssignment.count({ where: { clinicId: clinic.id, status: 'ACTIVE', role: { code: 'CLINIC_ADMIN' }, user: { status: 'ACTIVE' } } })).toBe(1);
    });

    it('deshabilitar a un administrador mientras se revoca la asignación del otro: solo una de las dos operaciones prospera', async () => {
      const clinic = await fx.clinic();
      const x = await fx.userWithRole('CLINIC_ADMIN', { clinicId: clinic.id });
      const y = await fx.userWithRole('CLINIC_ADMIN', { clinicId: clinic.id });
      const [t1, t2] = [(await platform()).token, (await platform()).token];
      const [d, r] = await Promise.all([
        disable(t1, x.user.id),
        ctx.http().patch(`/v1/assignments/${y.assignment.id}/revoke`).set(bearer(t2)).send(),
      ]);
      expect([d.status, r.status].sort((a, b) => a - b)).toEqual([200, 409]);
      expect(await ctx.db.userAssignment.count({ where: { clinicId: clinic.id, status: 'ACTIVE', role: { code: 'CLINIC_ADMIN' }, user: { status: 'ACTIVE' } } })).toBe(1);
    });

    it('dos Directores deshabilitados a la vez: solo uno prospera', async () => {
      const clinic = await fx.clinic();
      await fx.userWithRole('CLINIC_ADMIN', { clinicId: clinic.id });
      const d1 = await fx.userWithRole('CLINICAL_DIRECTOR', { clinicId: clinic.id });
      const d2 = await fx.userWithRole('CLINICAL_DIRECTOR', { clinicId: clinic.id });
      const [t1, t2] = [(await platform()).token, (await platform()).token];
      const results = await Promise.all([disable(t1, d1.user.id), disable(t2, d2.user.id)]);
      expect(results.map((r) => r.status).sort((x, y) => x - y)).toEqual([200, 409]);
      expect(await ctx.db.userAssignment.count({ where: { clinicId: clinic.id, status: 'ACTIVE', role: { code: 'CLINICAL_DIRECTOR' }, user: { status: 'ACTIVE' } } })).toBe(1);
    });

    it('administradores de dos clínicas deshabilitados en cruce: cada clínica conserva uno (sin deadlocks)', async () => {
      const c1 = await fx.clinic();
      const c2 = await fx.clinic();
      const shared = await fx.user(); // administrador en ambas clínicas
      await fx.assign(shared.id, 'CLINIC_ADMIN', { clinicId: c1.id });
      await fx.assign(shared.id, 'CLINIC_ADMIN', { clinicId: c2.id });
      const o1 = await fx.userWithRole('CLINIC_ADMIN', { clinicId: c1.id });
      const o2 = await fx.userWithRole('CLINIC_ADMIN', { clinicId: c2.id });
      const tokens = await Promise.all([1, 2, 3].map(() => platform().then((p) => p.token)));
      const results = await Promise.all([disable(tokens[0]!, shared.id), disable(tokens[1]!, o1.user.id), disable(tokens[2]!, o2.user.id)]);
      // ninguna respuesta 5xx por deadlock
      expect(results.every((r) => [200, 409].includes(r.status)), JSON.stringify(results.map((r) => [r.status, r.body]))).toBe(true);
      for (const c of [c1, c2]) {
        expect(await ctx.db.userAssignment.count({ where: { clinicId: c.id, status: 'ACTIVE', role: { code: 'CLINIC_ADMIN' }, user: { status: 'ACTIVE' } } })).toBeGreaterThanOrEqual(1);
      }
    });
  });
});
