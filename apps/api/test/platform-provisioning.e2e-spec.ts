import {
  acceptReq,
  actorIn,
  bearer,
  createPatient,
  createTestContext,
  Fixtures,
  inviteOk,
  inviteReq,
  loginInContext,
  NEW_PASSWORD,
  type TestContext,
  uniq,
} from './helpers/app.js';

describe('La plataforma solo aprovisiona al PRIMER administrador (sin acceso a datos de pacientes)', () => {
  let ctx: TestContext;
  let fx: Fixtures;
  beforeAll(async () => {
    ctx = await createTestContext();
    fx = new Fixtures(ctx.db);
  });
  afterAll(() => ctx.close());

  async function platform() {
    const { user } = await fx.userWithRole('PLATFORM_ADMIN');
    return { user, token: await loginInContext(ctx, user.email) };
  }
  const email = () => `${uniq('adm')}@test.pe`;

  it('invita al primer CLINIC_ADMIN de una clínica sin administrador; la persona define su contraseña', async () => {
    const p = await platform();
    const clinic = await fx.clinic();
    const to = email();
    const { id, token, res } = await inviteOk(ctx, p.token, { email: to, roleCode: 'CLINIC_ADMIN', clinicId: clinic.id });
    expect(res.body).toMatchObject({ clinicId: clinic.id, branchId: null, role: { code: 'CLINIC_ADMIN' } });
    expect((await ctx.db.invitation.findUniqueOrThrow({ where: { id } })).issuedByPlatform).toBe(true);
    const [log] = await ctx.db.auditLog.findMany({ where: { entityId: id, action: 'INVITATION_CREATED' } });
    expect(log!.summary).toMatchObject({ issuedByPlatform: true, roleCode: 'CLINIC_ADMIN' });

    await acceptReq(ctx, token, { password: 'Clave-Elegida-Por-El-Admin-1' }).expect(200);
    const adminToken = await loginInContext(ctx, to, { clinicId: clinic.id }, 'Clave-Elegida-Por-El-Admin-1');
    const me = await ctx.http().get('/v1/auth/me').set(bearer(adminToken)).expect(200);
    expect(me.body.roles).toEqual(['CLINIC_ADMIN']);

    // la plataforma lo ve en su listado (metadatos) pero no obtuvo acceso a nada de la clínica
    const list = await ctx.http().get('/v1/invitations?limit=100').set(bearer(p.token)).expect(200);
    expect(list.body.find((i: { id: string }) => i.id === id).status).toBe('ACCEPTED');
  });

  it('la ventana se cierra: con un administrador activo la plataforma ya no puede invitar administradores', async () => {
    const p = await platform();
    const clinic = await fx.clinic();
    const admin = await actorIn(ctx, fx, 'CLINIC_ADMIN', { clinicId: clinic.id });
    const res = await inviteReq(ctx, p.token, { email: email(), roleCode: 'CLINIC_ADMIN', clinicId: clinic.id }).expect(409);
    expect(res.body).toMatchObject({ code: 'CLINIC_HAS_ADMIN' });
    expect(await ctx.db.invitation.count({ where: { clinicId: clinic.id } })).toBe(0);
    // la administración propia sí puede invitar a otro administrador
    await inviteOk(ctx, admin.token, { email: email(), roleCode: 'CLINIC_ADMIN' });
  });

  it('solo cuentan los administradores operativos: de toda la clínica, activos y con usuario activo', async () => {
    const p = await platform();
    // solo un administrador de UNA SEDE: no es autoridad de la clínica
    const c1 = await fx.clinic();
    const b1 = await fx.branch(c1.id);
    await fx.userWithRole('CLINIC_ADMIN', { clinicId: c1.id, branchId: b1.id });
    await inviteOk(ctx, p.token, { email: email(), roleCode: 'CLINIC_ADMIN', clinicId: c1.id });
    // administrador con usuario deshabilitado
    const c2 = await fx.clinic();
    const dead = await fx.userWithRole('CLINIC_ADMIN', { clinicId: c2.id });
    await ctx.db.user.update({ where: { id: dead.user.id }, data: { status: 'DISABLED' } });
    await inviteOk(ctx, p.token, { email: email(), roleCode: 'CLINIC_ADMIN', clinicId: c2.id });
    // asignación revocada
    const c3 = await fx.clinic();
    const revoked = await fx.userWithRole('CLINIC_ADMIN', { clinicId: c3.id });
    await ctx.db.userAssignment.update({ where: { id: revoked.assignment.id }, data: { status: 'INACTIVE' } });
    await inviteOk(ctx, p.token, { email: email(), roleCode: 'CLINIC_ADMIN', clinicId: c3.id });
  });

  it('la plataforma no invita a ningún otro rol de clínica ni designa Directores', async () => {
    const p = await platform();
    const clinic = await fx.clinic();
    for (const roleCode of ['DENTIST', 'RECEPTIONIST', 'CASHIER', 'ASSISTANT', 'CLINICAL_DIRECTOR']) {
      const res = await inviteReq(ctx, p.token, { email: email(), roleCode, clinicId: clinic.id });
      expect(res.status, roleCode).toBe(403);
    }
    expect(await ctx.db.invitation.count({ where: { clinicId: clinic.id } })).toBe(0);
  });

  it('valida el destino: clínica obligatoria, sin sede, clínica activa; PLATFORM_ADMIN sin clínica', async () => {
    const p = await platform();
    const clinic = await fx.clinic();
    const branch = await fx.branch(clinic.id);
    await inviteReq(ctx, p.token, { email: email(), roleCode: 'CLINIC_ADMIN' }).expect(400);
    await inviteReq(ctx, p.token, { email: email(), roleCode: 'CLINIC_ADMIN', clinicId: clinic.id, branchId: branch.id }).expect(400);
    await inviteReq(ctx, p.token, { email: email(), roleCode: 'PLATFORM_ADMIN', clinicId: clinic.id }).expect(400);
    const inactive = await fx.clinic();
    await ctx.db.clinic.update({ where: { id: inactive.id }, data: { status: 'INACTIVE' } });
    await inviteReq(ctx, p.token, { email: email(), roleCode: 'CLINIC_ADMIN', clinicId: inactive.id }).expect(400);
    await inviteReq(ctx, p.token, { email: email(), roleCode: 'CLINIC_ADMIN', clinicId: '8e5f2c5a-7d3e-4f52-9d7c-3b7a1e9d6c11' }).expect(400);
  });

  it('puede invitar a otro administrador de plataforma (sin clínica)', async () => {
    const p = await platform();
    const to = email();
    const { token } = await inviteOk(ctx, p.token, { email: to, roleCode: 'PLATFORM_ADMIN' });
    await acceptReq(ctx, token).expect(200);
    const assignment = await ctx.db.userAssignment.findFirstOrThrow({ where: { user: { email: to } } });
    expect(assignment).toMatchObject({ clinicId: null, branchId: null, status: 'ACTIVE' });
  });

  it('dos invitaciones de plataforma a la misma clínica: solo una puede aceptarse', async () => {
    const p = await platform();
    const clinic = await fx.clinic();
    const first = await inviteOk(ctx, p.token, { email: email(), roleCode: 'CLINIC_ADMIN', clinicId: clinic.id });
    const second = await inviteOk(ctx, p.token, { email: email(), roleCode: 'CLINIC_ADMIN', clinicId: clinic.id });
    await acceptReq(ctx, first.token).expect(200);
    await acceptReq(ctx, second.token).expect(404); // la clínica ya tiene administrador
    expect((await ctx.db.auditLog.findMany({ where: { entityId: second.id, action: 'INVITATION_REJECTED' } }))[0]!.summary).toEqual({ reason: 'clinic_has_admin' });
    // aceptación simultánea: exactamente una
    const c2 = await fx.clinic();
    const a = await inviteOk(ctx, p.token, { email: email(), roleCode: 'CLINIC_ADMIN', clinicId: c2.id });
    const b = await inviteOk(ctx, p.token, { email: email(), roleCode: 'CLINIC_ADMIN', clinicId: c2.id });
    const results = await Promise.all([acceptReq(ctx, a.token), acceptReq(ctx, b.token)]);
    expect(results.map((r) => r.status).sort((x, y) => x - y)).toEqual([200, 404]);
    expect(await ctx.db.userAssignment.count({ where: { clinicId: c2.id, status: 'ACTIVE', role: { code: 'CLINIC_ADMIN' } } })).toBe(1);
  });

  it('si el administrador de plataforma que invitó pierde su rol, la invitación ya no sirve', async () => {
    const p = await platform();
    const clinic = await fx.clinic();
    const { id, token } = await inviteOk(ctx, p.token, { email: email(), roleCode: 'CLINIC_ADMIN', clinicId: clinic.id });
    await ctx.db.userAssignment.updateMany({ where: { userId: p.user.id }, data: { status: 'INACTIVE' } });
    await acceptReq(ctx, token).expect(404);
    expect((await ctx.db.auditLog.findMany({ where: { entityId: id, action: 'INVITATION_REJECTED' } }))[0]!.summary).toEqual({ reason: 'inviter_lost_authority' });
  });

  it('crear o gestionar invitaciones NO da a la plataforma ningún acceso a pacientes, consentimientos ni adjuntos', async () => {
    const p = await platform();
    const clinic = await fx.clinic();
    const { token } = await inviteOk(ctx, p.token, { email: email(), roleCode: 'CLINIC_ADMIN', clinicId: clinic.id });
    await acceptReq(ctx, token).expect(200);
    const reception = await actorIn(ctx, fx, 'RECEPTIONIST', { clinicId: clinic.id });
    const { id: patientId } = await createPatient(ctx, reception.token);

    const me = await ctx.http().get('/v1/auth/me').set(bearer(p.token)).expect(200);
    const perms: string[] = me.body.permissions;
    expect(perms).toEqual(expect.arrayContaining(['invitation:manage', 'invitation:read']));
    for (const forbidden of ['patient:', 'consent:', 'attachment:', 'clinical:', 'provisioning:', 'director:']) {
      expect(perms.filter((x) => x.startsWith(forbidden))).toEqual([]);
    }
    for (const path of ['/v1/patients', `/v1/patients/${patientId}`, `/v1/patients/${patientId}/consents`, `/v1/patients/${patientId}/attachments`, '/v1/provisioning-records']) {
      expect((await ctx.http().get(path).set(bearer(p.token))).status, path).toBe(403);
    }
  });

  it('RIESGO RESIDUAL DOCUMENTADO: la plataforma puede invitar un correo que ella controla a una clínica sin administrador, pero queda totalmente trazado', async () => {
    const p = await platform();
    const clinic = await fx.clinic();
    const controlled = email();
    const { id, token } = await inviteOk(ctx, p.token, { email: controlled, roleCode: 'CLINIC_ADMIN', clinicId: clinic.id });
    await acceptReq(ctx, token).expect(200); // el sistema no puede saber que ese correo es del propio operador
    const adminToken = await loginInContext(ctx, controlled, { clinicId: clinic.id }, NEW_PASSWORD);
    const me = await ctx.http().get('/v1/auth/me').set(bearer(adminToken)).expect(200);
    // Desde que administración tiene acceso clínico total (clinical:admin), este riesgo residual incluye esa lectura/escritura
    // (siempre auditada). Sigue sin poder designar Director por sí solo (exige registro formal + reautenticación) ni read_all.
    expect(me.body.permissions).toContain('clinical:admin');
    expect(me.body.permissions.filter((x: string) => x === 'clinical:read_all' || x === 'director:manage')).toEqual([]);
    await inviteReq(ctx, adminToken, { email: email(), roleCode: 'CLINICAL_DIRECTOR' }).expect(400);
    // la trazabilidad permite detectarlo: quién invitó (plataforma), a quién (enmascarado) y quién aceptó
    const trail = await ctx.db.auditLog.findMany({ where: { entityId: id } });
    expect(trail.map((t) => t.action)).toEqual(expect.arrayContaining(['INVITATION_CREATED', 'INVITATION_ACCEPTED']));
    expect(trail.find((t) => t.action === 'INVITATION_CREATED')!.userId).toBe(p.user.id);
  });
});
