import {
  actorIn,
  bearer,
  createPatient,
  createTestContext,
  csrfHeaders,
  Fixtures,
  login,
  loginFull,
  loginInContext,
  PASSWORD,
  reauthProofFor,
  refreshWith,
  type TestContext,
  uniq,
} from './helpers/app.js';

describe('Auditoría de accesos denegados (403) y rechazos de reautenticación', () => {
  let ctx: TestContext;
  let fx: Fixtures;
  beforeAll(async () => {
    ctx = await createTestContext();
    fx = new Fixtures(ctx.db);
  });
  afterAll(() => ctx.close());

  const denials = (userId: string) => ctx.db.auditLog.findMany({ where: { userId, action: 'ACCESS_DENIED' }, orderBy: { createdAt: 'asc' } });

  it('un 403 por falta de permiso se audita con usuario, clínica, IP, ruta (patrón) y permisos exigidos', async () => {
    const clinic = await fx.clinic();
    const reception = await actorIn(ctx, fx, 'RECEPTIONIST', { clinicId: clinic.id });
    const secretEmail = `${uniq('secreto')}@test.pe`;
    await ctx.http().post('/v1/invitations').set(bearer(reception.token)).send({ email: secretEmail, roleCode: 'DENTIST' }).expect(403);

    const [log] = await denials(reception.user.id);
    expect(log).toMatchObject({ userId: reception.user.id, clinicId: clinic.id, entity: 'Request' });
    expect(log!.ip).toBeTruthy();
    expect(log!.summary).toEqual({
      method: 'POST',
      route: '/v1/invitations',
      reason: 'missing_permission',
      requiredPermissions: ['invitation:manage', 'director:manage'],
    });
    // nada del cuerpo ni de la solicitud
    const dump = JSON.stringify(log);
    for (const leak of [secretEmail, 'Contraseña-Del-Cuerpo-1', 'Bearer', 'eyJ']) expect(dump).not.toContain(leak);
  });

  it('se registra el PATRÓN de la ruta, nunca los ids ni la consulta (datos clínicos/personales)', async () => {
    const clinic = await fx.clinic();
    const reception = await actorIn(ctx, fx, 'RECEPTIONIST', { clinicId: clinic.id });
    const cashier = await actorIn(ctx, fx, 'CASHIER', { clinicId: clinic.id });
    const { id } = await createPatient(ctx, reception.token);
    await ctx.http().get(`/v1/patients/${id}/consents?name=Maria&dni=12345678`).set(bearer(cashier.token)).expect(403);
    const [log] = await denials(cashier.user.id);
    expect(log!.summary).toMatchObject({ route: '/v1/patients/:id/consents', reason: 'missing_permission', requiredPermissions: ['consent:read'] });
    const dump = JSON.stringify(await ctx.db.auditLog.findMany({ where: { userId: cashier.user.id } }));
    for (const leak of [id, 'Maria', '12345678']) expect(dump).not.toContain(leak);
  });

  it('distingue el motivo: sin contexto activo, falta de permiso y 403 de servicio', async () => {
    const clinic = await fx.clinic();
    const admin = await actorIn(ctx, fx, 'CLINIC_ADMIN', { clinicId: clinic.id });
    const noContext = await login(ctx, admin.user.email);
    await ctx.http().get('/v1/branches').set(bearer(noContext)).expect(403);
    // 403 lanzado por una regla de servicio (no por el guard): el administrador no otorga roles de plataforma
    const target = await fx.user();
    await ctx.http().post('/v1/assignments').set(bearer(admin.token)).send({ userId: target.id, roleCode: 'PLATFORM_ADMIN' }).expect(403);
    const logs = await denials(admin.user.id);
    expect(logs.map((l) => (l.summary as { reason: string }).reason).sort((a, b) => a.localeCompare(b))).toEqual(['forbidden', 'no_context']);
    expect(logs.find((l) => (l.summary as { reason: string }).reason === 'no_context')!.summary).toMatchObject({ route: '/v1/branches', requiredPermissions: ['branch:read'] });
    expect(logs.find((l) => (l.summary as { reason: string }).reason === 'forbidden')!.summary).toMatchObject({ route: '/v1/assignments', requiredPermissions: [] });
  });

  it('la plataforma sin acceso a pacientes también queda registrada (clínica nula)', async () => {
    const { user } = await fx.userWithRole('PLATFORM_ADMIN');
    const token = await loginInContext(ctx, user.email);
    await ctx.http().get('/v1/patients').set(bearer(token)).expect(403);
    const [log] = await denials(user.id);
    expect(log).toMatchObject({ clinicId: null });
    expect(log!.summary).toMatchObject({ route: '/v1/patients', reason: 'missing_permission' });
  });

  it('deduplica: la misma negativa repetida deja un solo registro; otra ruta, otro', async () => {
    const clinic = await fx.clinic();
    const cashier = await actorIn(ctx, fx, 'CASHIER', { clinicId: clinic.id });
    for (let i = 0; i < 6; i++) await ctx.http().get('/v1/users').set(bearer(cashier.token)).expect(403);
    expect(await denials(cashier.user.id)).toHaveLength(1);
    await ctx.http().get('/v1/roles').set(bearer(cashier.token)).expect(403);
    expect(await denials(cashier.user.id)).toHaveLength(2);
  });

  it('no audita lo que no es una denegación de un usuario autenticado: 401, 400, 404 ni el 403 de CSRF', async () => {
    const clinic = await fx.clinic();
    const admin = await actorIn(ctx, fx, 'CLINIC_ADMIN', { clinicId: clinic.id });
    const before = await ctx.db.auditLog.count({ where: { action: 'ACCESS_DENIED' } });
    await ctx.http().get('/v1/branches').expect(401);
    await ctx.http().get('/v1/branches').set('Authorization', 'Bearer basura').expect(401);
    await ctx.http().post('/v1/invitations').set(bearer(admin.token)).send({}).expect(400);
    await ctx.http().get('/v1/patients/8e5f2c5a-7d3e-4f52-9d7c-3b7a1e9d6c11').set(bearer(admin.token)).expect(404);
    const s = await loginFull(ctx, admin.user.email);
    await refreshWith(ctx, s.refreshToken, { 'X-Requested-With': 'ApiDental', 'Content-Type': 'application/json' }).expect(403); // CSRF: sin identidad
    await refreshWith(ctx, s.refreshToken, { ...csrfHeaders, Origin: 'https://evil.example' }).expect(403);
    expect(await ctx.db.auditLog.count({ where: { action: 'ACCESS_DENIED' } })).toBe(before);
  });

  it('cada clínica ve solo sus denegaciones en la auditoría', async () => {
    const a = await fx.clinic();
    const b = await fx.clinic();
    const adminA = await actorIn(ctx, fx, 'CLINIC_ADMIN', { clinicId: a.id });
    const adminB = await actorIn(ctx, fx, 'CLINIC_ADMIN', { clinicId: b.id });
    const cashierA = await actorIn(ctx, fx, 'CASHIER', { clinicId: a.id });
    await ctx.http().get('/v1/users').set(bearer(cashierA.token)).expect(403);
    const seen = await ctx.http().get('/v1/audit-logs?action=ACCESS_DENIED&limit=100').set(bearer(adminA.token)).expect(200);
    expect(seen.body.some((l: { userId: string }) => l.userId === cashierA.user.id)).toBe(true);
    expect(seen.body.every((l: { clinicId: string }) => l.clinicId === a.id)).toBe(true);
    const other = await ctx.http().get('/v1/audit-logs?action=ACCESS_DENIED&limit=100').set(bearer(adminB.token)).expect(200);
    expect(other.body.some((l: { userId: string }) => l.userId === cashierA.user.id)).toBe(false);
  });

  describe('reautenticación', () => {
    it('una contraseña incorrecta se audita como REAUTH_FAILED con el número de intento', async () => {
      const user = await fx.user();
      const { accessToken } = await loginFull(ctx, user.email);
      await ctx.http().post('/v1/auth/reauthenticate').set(bearer(accessToken)).send({ password: 'Incorrecta-12345', purpose: 'CLOSE_CLINICAL_NOTE' }).expect(401);
      const [log] = await ctx.db.auditLog.findMany({ where: { userId: user.id, action: 'REAUTH_FAILED' } });
      expect(log!.summary).toMatchObject({ attempts: 1, reason: 'bad_password' });
      expect(JSON.stringify(log)).not.toContain('Incorrecta-12345');
    });

    it('el rechazo de una prueba (propósito, objeto, uso o vencimiento) se audita como REAUTH_REJECTED sin el token', async () => {
      const clinic = await fx.clinic();
      const admin = await actorIn(ctx, fx, 'CLINIC_ADMIN', { clinicId: clinic.id });
      const body = {
        designeeName: 'Dra. Prueba', designeeEmail: `${uniq('d')}@test.pe`, authorizedByName: 'Representante', authorizedByPosition: 'Gerente',
        authorizedByDocumentType: 'DNI', authorizedByDocumentNumber: '45678901', authorizationReference: 'Acta 1-2026',
        authorizationDate: new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10),
      };
      const wrongPurpose = await reauthProofFor(ctx, admin.token, 'CLINICAL_READ_ALL', clinic.id);
      await ctx.http().post('/v1/provisioning-records').set(bearer(admin.token)).send({ ...body, reauthToken: wrongPurpose }).expect(403);
      const wrongTarget = await reauthProofFor(ctx, admin.token, 'AUTHORIZE_DIRECTOR_PROVISIONING', (await fx.clinic()).id);
      await ctx.http().post('/v1/provisioning-records').set(bearer(admin.token)).send({ ...body, reauthToken: wrongTarget }).expect(403);
      await ctx.http().post('/v1/provisioning-records').set(bearer(admin.token)).send({ ...body, reauthToken: 'rp_' + 'A'.repeat(43) }).expect(403);

      const logs = await ctx.db.auditLog.findMany({ where: { userId: admin.user.id, action: 'REAUTH_REJECTED' } });
      expect(logs.map((l) => (l.summary as { reason: string }).reason).sort((a, b) => a.localeCompare(b))).toEqual(['other_purpose', 'other_target', 'unknown']);
      expect(logs.every((l) => (l.summary as { purpose: string }).purpose === 'AUTHORIZE_DIRECTOR_PROVISIONING')).toBe(true);
      expect(logs.every((l) => l.ip)).toBe(true);
      const dump = JSON.stringify(logs);
      for (const secret of [wrongPurpose, wrongTarget, 'rp_' + 'A'.repeat(43)]) expect(dump).not.toContain(secret);
    });

    it('la reutilización de un refresh token sigue auditándose (REFRESH_REUSE_DETECTED)', async () => {
      const user = await fx.user();
      const s = await loginFull(ctx, user.email);
      await refreshWith(ctx, s.refreshToken).expect(200);
      await refreshWith(ctx, s.refreshToken).expect(401);
      expect(await ctx.db.auditLog.count({ where: { userId: user.id, action: 'REFRESH_REUSE_DETECTED' } })).toBe(1);
      expect(PASSWORD).toBeTruthy();
    });
  });
});
