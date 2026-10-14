import { bearer, createTestContext, Fixtures, login, PASSWORD, uniq, type TestContext } from './helpers/app.js';

describe('Autenticación', () => {
  let ctx: TestContext;
  let fx: Fixtures;
  beforeAll(async () => {
    ctx = await createTestContext();
    fx = new Fixtures(ctx.db);
  });
  afterAll(() => ctx.close());

  describe('POST /v1/auth/login', () => {
    it('con credenciales correctas devuelve token, usuario y contextos disponibles', async () => {
      const clinic = await fx.clinic();
      const { user } = await fx.userWithRole('CLINIC_ADMIN', { clinicId: clinic.id });
      const res = await ctx.http().post('/v1/auth/login').send({ email: user.email, password: PASSWORD }).expect(200);

      expect(res.body.accessToken).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
      expect(res.body).toMatchObject({ tokenType: 'Bearer', expiresIn: 900 });
      expect(res.body.user).toEqual({ id: user.id, email: user.email, firstName: 'Nombre', lastName: 'Apellido' });
      expect(res.body.contexts).toHaveLength(1);
      expect(res.body.contexts[0]).toMatchObject({ role: { code: 'CLINIC_ADMIN' }, clinic: { id: clinic.id }, branch: null });
    });

    it('normaliza el correo (mayúsculas y espacios)', async () => {
      const user = await fx.user();
      await ctx.http().post('/v1/auth/login').send({ email: `  ${user.email.toUpperCase()} `, password: PASSWORD }).expect(200);
    });

    it('registra lastLoginAt y auditoría LOGIN_SUCCESS con IP y user agent', async () => {
      const user = await fx.user();
      await ctx.http().post('/v1/auth/login').set('User-Agent', 'vitest-agent').send({ email: user.email, password: PASSWORD }).expect(200);
      const refreshed = await ctx.db.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(refreshed.lastLoginAt).toBeInstanceOf(Date);
      const log = await ctx.db.auditLog.findFirstOrThrow({ where: { userId: user.id, action: 'LOGIN_SUCCESS' } });
      expect(log.userAgent).toBe('vitest-agent');
      expect(log.ip).toBeTruthy();
    });

    it('rechaza contraseña incorrecta y usuario inexistente con el mismo mensaje', async () => {
      const user = await fx.user();
      const wrongPass = await ctx.http().post('/v1/auth/login').send({ email: user.email, password: 'incorrecta-123456' }).expect(401);
      const unknown = await ctx.http().post('/v1/auth/login').send({ email: `${uniq('no')}@test.pe`, password: 'incorrecta-123456' }).expect(401);
      expect(wrongPass.body.message).toBe('Credenciales inválidas');
      expect(unknown.body.message).toBe(wrongPass.body.message);
    });

    it('rechaza usuarios deshabilitados aunque la contraseña sea correcta', async () => {
      const user = await fx.user({ status: 'DISABLED' });
      await ctx.http().post('/v1/auth/login').send({ email: user.email, password: PASSWORD }).expect(401);
    });

    it('valida el cuerpo: correo inválido, campos ausentes y propiedades extra', async () => {
      await ctx.http().post('/v1/auth/login').send({ email: 'no-es-correo', password: 'x' }).expect(400);
      await ctx.http().post('/v1/auth/login').send({}).expect(400);
      await ctx.http().post('/v1/auth/login').send({ email: 'a@b.pe', password: 'x', isAdmin: true }).expect(400);
    });

    it('bloquea la cuenta tras exceder los intentos y el bloqueo rige aun con la clave correcta', async () => {
      const user = await fx.user();
      for (let i = 0; i < 3; i++) {
        await ctx.http().post('/v1/auth/login').send({ email: user.email, password: 'incorrecta-123456' }).expect(401);
      }
      const row = await ctx.db.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(row.failedLoginAttempts).toBe(3);
      expect(row.lockedUntil!.getTime()).toBeGreaterThan(Date.now());

      await ctx.http().post('/v1/auth/login').send({ email: user.email, password: PASSWORD }).expect(401);
      const actions = (await ctx.db.auditLog.findMany({ where: { userId: user.id } })).map((l) => l.action);
      expect(actions).toEqual(expect.arrayContaining(['LOGIN_FAILED', 'LOGIN_LOCKED', 'LOGIN_BLOCKED']));
    });

    it('un login correcto reinicia el contador de intentos', async () => {
      const user = await fx.user();
      await ctx.http().post('/v1/auth/login').send({ email: user.email, password: 'incorrecta-123456' }).expect(401);
      await ctx.http().post('/v1/auth/login').send({ email: user.email, password: PASSWORD }).expect(200);
      const row = await ctx.db.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(row.failedLoginAttempts).toBe(0);
    });

    it('nunca expone passwordHash ni hashes en ninguna respuesta de autenticación', async () => {
      const clinic = await fx.clinic();
      const { user } = await fx.userWithRole('CLINIC_ADMIN', { clinicId: clinic.id });
      const loginRes = await ctx.http().post('/v1/auth/login').send({ email: user.email, password: PASSWORD }).expect(200);
      const token = loginRes.body.accessToken as string;
      const me = await ctx.http().get('/v1/auth/me').set(bearer(token)).expect(200);
      const contexts = await ctx.http().get('/v1/auth/context').set(bearer(token)).expect(200);
      const failed = await ctx.http().post('/v1/auth/login').send({ email: user.email, password: 'mala-clave-1234' }).expect(401);
      for (const body of [loginRes.body, me.body, contexts.body, failed.body]) {
        const text = JSON.stringify(body);
        expect(text).not.toMatch(/passwordHash|password_hash|\$argon2/);
      }
    });

    it('la contraseña se guarda como hash Argon2id, nunca en claro', async () => {
      const user = await ctx.db.user.findFirstOrThrow({ omit: { passwordHash: false } });
      expect(user.passwordHash.startsWith('$argon2id$')).toBe(true);
      expect(user.passwordHash).not.toContain(PASSWORD);
    });
  });

  describe('rutas protegidas', () => {
    it('rechazan solicitudes sin JWT', async () => {
      for (const path of ['/v1/auth/me', '/v1/auth/context', '/v1/branches', '/v1/clinics', '/v1/users', '/v1/roles', '/v1/audit-logs']) {
        await ctx.http().get(path).expect(401);
      }
      await ctx.http().post('/v1/auth/select-context').send({}).expect(401);
    });

    it('rechazan tokens inválidos, manipulados o con esquema distinto', async () => {
      const user = await fx.user();
      const token = await login(ctx, user.email);
      await ctx.http().get('/v1/auth/me').set('Authorization', 'Bearer basura').expect(401);
      await ctx.http().get('/v1/auth/me').set('Authorization', `Bearer ${token.slice(0, -3)}abc`).expect(401);
      await ctx.http().get('/v1/auth/me').set('Authorization', `Basic ${token}`).expect(401);
    });

    it('GET /v1/auth/me devuelve el perfil sin contexto', async () => {
      const user = await fx.user();
      const token = await login(ctx, user.email);
      const res = await ctx.http().get('/v1/auth/me').set(bearer(token)).expect(200);
      expect(res.body).toMatchObject({ user: { id: user.id }, context: null, roles: [], permissions: [] });
    });

    it('un token sin contexto activo no accede a recursos con permisos', async () => {
      const clinic = await fx.clinic();
      const { user } = await fx.userWithRole('CLINIC_ADMIN', { clinicId: clinic.id });
      const token = await login(ctx, user.email);
      const res = await ctx.http().get('/v1/branches').set(bearer(token)).expect(403);
      expect(res.body.message).toMatch(/clínica\/sede activa/);
    });

    it('un usuario deshabilitado pierde acceso de inmediato, aunque su token siga vigente', async () => {
      const user = await fx.user();
      const token = await login(ctx, user.email);
      await ctx.http().get('/v1/auth/me').set(bearer(token)).expect(200);
      await ctx.db.user.update({ where: { id: user.id }, data: { status: 'DISABLED' } });
      await ctx.http().get('/v1/auth/me').set(bearer(token)).expect(401);
    });
  });

  describe('contexto activo (clínica/sede)', () => {
    it('lista solo los contextos de las asignaciones activas del usuario', async () => {
      const clinic = await fx.clinic();
      const other = await fx.clinic();
      const branch = await fx.branch(clinic.id);
      const user = await fx.user();
      await fx.assign(user.id, 'DENTIST', { clinicId: clinic.id, branchId: branch.id });
      const revoked = await fx.assign(user.id, 'ASSISTANT', { clinicId: other.id });
      await ctx.db.userAssignment.update({ where: { id: revoked.id }, data: { status: 'INACTIVE' } });

      const token = await login(ctx, user.email);
      const res = await ctx.http().get('/v1/auth/context').set(bearer(token)).expect(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({ role: { code: 'DENTIST' }, clinic: { id: clinic.id }, branch: { id: branch.id } });
    });

    it('permite seleccionar un contexto asignado y devuelve roles y permisos efectivos', async () => {
      const clinic = await fx.clinic();
      const { user } = await fx.userWithRole('CLINIC_ADMIN', { clinicId: clinic.id });
      const token = await login(ctx, user.email);
      const res = await ctx.http().post('/v1/auth/select-context').set(bearer(token)).send({ clinicId: clinic.id }).expect(200);
      expect(res.body.roles).toEqual(['CLINIC_ADMIN']);
      expect(res.body.permissions).toContain('user:manage');
      expect(res.body.permissions).not.toContain('clinic:manage');
      expect(res.body.context).toMatchObject({ platform: false, clinic: { id: clinic.id }, branch: null });

      const me = await ctx.http().get('/v1/auth/me').set(bearer(res.body.accessToken)).expect(200);
      expect(me.body.context.clinic.id).toBe(clinic.id);
    });

    it('rechaza una clínica sin asignación y lo audita', async () => {
      const mine = await fx.clinic();
      const foreign = await fx.clinic();
      const { user } = await fx.userWithRole('CLINIC_ADMIN', { clinicId: mine.id });
      const token = await login(ctx, user.email);
      await ctx.http().post('/v1/auth/select-context').set(bearer(token)).send({ clinicId: foreign.id }).expect(403);
      const log = await ctx.db.auditLog.findFirst({ where: { userId: user.id, action: 'CONTEXT_DENIED' } });
      expect(log?.clinicId).toBe(foreign.id);
    });

    it('rechaza una sede sin asignación aunque la clínica sea suya', async () => {
      const clinic = await fx.clinic();
      const allowed = await fx.branch(clinic.id);
      const forbidden = await fx.branch(clinic.id);
      const { user } = await fx.userWithRole('RECEPTIONIST', { clinicId: clinic.id, branchId: allowed.id });
      const token = await login(ctx, user.email);
      await ctx.http().post('/v1/auth/select-context').set(bearer(token)).send({ clinicId: clinic.id, branchId: forbidden.id }).expect(403);
      await ctx.http().post('/v1/auth/select-context').set(bearer(token)).send({ clinicId: clinic.id, branchId: allowed.id }).expect(200);
    });

    it('un usuario con asignación solo de sede no puede elegir el contexto de toda la clínica', async () => {
      const clinic = await fx.clinic();
      const branch = await fx.branch(clinic.id);
      const { user } = await fx.userWithRole('DENTIST', { clinicId: clinic.id, branchId: branch.id });
      const token = await login(ctx, user.email);
      await ctx.http().post('/v1/auth/select-context').set(bearer(token)).send({ clinicId: clinic.id }).expect(403);
    });

    it('una sede de otra clínica nunca es válida (aunque se combine con una clínica propia)', async () => {
      const mine = await fx.clinic();
      const foreign = await fx.clinic();
      const foreignBranch = await fx.branch(foreign.id);
      const { user } = await fx.userWithRole('CLINIC_ADMIN', { clinicId: mine.id });
      const token = await login(ctx, user.email);
      await ctx.http().post('/v1/auth/select-context').set(bearer(token)).send({ clinicId: mine.id, branchId: foreignBranch.id }).expect(403);
    });

    it('el contexto de plataforma exige un rol de plataforma', async () => {
      const clinic = await fx.clinic();
      const { user: clinicAdmin } = await fx.userWithRole('CLINIC_ADMIN', { clinicId: clinic.id });
      const { user: platformAdmin } = await fx.userWithRole('PLATFORM_ADMIN');
      const t1 = await login(ctx, clinicAdmin.email);
      await ctx.http().post('/v1/auth/select-context').set(bearer(t1)).send({}).expect(403);
      const t2 = await login(ctx, platformAdmin.email);
      const res = await ctx.http().post('/v1/auth/select-context').set(bearer(t2)).send({}).expect(200);
      expect(res.body.context.platform).toBe(true);
    });

    it('no acepta branchId sin clinicId ni UUIDs inválidos', async () => {
      const user = await fx.user();
      const token = await login(ctx, user.email);
      await ctx.http().post('/v1/auth/select-context').set(bearer(token)).send({ branchId: '8e5f2c5a-7d3e-4f52-9d7c-3b7a1e9d6c11' }).expect(403);
      await ctx.http().post('/v1/auth/select-context').set(bearer(token)).send({ clinicId: 'no-uuid' }).expect(400);
    });

    it('revocar la asignación invalida el contexto en la siguiente solicitud', async () => {
      const clinic = await fx.clinic();
      const { user, assignment } = await fx.userWithRole('CLINIC_ADMIN', { clinicId: clinic.id });
      const token = await login(ctx, user.email);
      const ctxToken = (await ctx.http().post('/v1/auth/select-context').set(bearer(token)).send({ clinicId: clinic.id }).expect(200)).body.accessToken;
      await ctx.http().get('/v1/branches').set(bearer(ctxToken)).expect(200);
      await ctx.db.userAssignment.update({ where: { id: assignment.id }, data: { status: 'INACTIVE' } });
      await ctx.http().get('/v1/branches').set(bearer(ctxToken)).expect(403);
    });

    it('una clínica inactiva deja sin acceso a sus usuarios', async () => {
      const clinic = await fx.clinic();
      const { user } = await fx.userWithRole('CLINIC_ADMIN', { clinicId: clinic.id });
      const token = await login(ctx, user.email);
      const ctxToken = (await ctx.http().post('/v1/auth/select-context').set(bearer(token)).send({ clinicId: clinic.id }).expect(200)).body.accessToken;
      await ctx.db.clinic.update({ where: { id: clinic.id }, data: { status: 'INACTIVE' } });
      await ctx.http().get('/v1/branches').set(bearer(ctxToken)).expect(403);
    });
  });
});
