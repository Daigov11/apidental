import { actorIn, bearer, createTestContext, Fixtures, inviteReq, type TestContext, uniq } from './helpers/app.js';

// Sin canal de entrega configurado (valor por defecto en producción) las invitaciones fallan CERRADAS.
process.env['INVITATION_DELIVERY_MODE'] = 'disabled';

describe('Invitaciones sin canal de entrega configurado', () => {
  let ctx: TestContext;
  let fx: Fixtures;
  beforeAll(async () => {
    ctx = await createTestContext();
    fx = new Fixtures(ctx.db);
  });
  afterAll(() => ctx.close());

  it('crear responde 503 y no deja ninguna invitación (el token se habría perdido)', async () => {
    const clinic = await fx.clinic();
    const admin = await actorIn(ctx, fx, 'CLINIC_ADMIN', { clinicId: clinic.id });
    const res = await inviteReq(ctx, admin.token, { email: `${uniq('d')}@test.pe`, roleCode: 'DENTIST' }).expect(503);
    expect(res.body.message).toMatch(/canal de entrega/);
    expect(JSON.stringify(res.body)).not.toMatch(/inv_|#token|devAcceptUrl/);
    expect(await ctx.db.invitation.count({ where: { clinicId: clinic.id } })).toBe(0);
    expect(await ctx.db.auditLog.count({ where: { clinicId: clinic.id, action: 'INVITATION_CREATED' } })).toBe(0);
  });

  it('listar sigue funcionando y reenviar también responde 503', async () => {
    const clinic = await fx.clinic();
    const admin = await actorIn(ctx, fx, 'CLINIC_ADMIN', { clinicId: clinic.id });
    await ctx.http().get('/v1/invitations').set(bearer(admin.token)).expect(200);
    await ctx.http().post('/v1/invitations/8e5f2c5a-7d3e-4f52-9d7c-3b7a1e9d6c11/resend').set(bearer(admin.token)).send({}).expect(503);
  });
});
