import {
  actorIn,
  bearer,
  createPatient,
  createTestContext,
  Fixtures,
  uniq,
  type TestContext,
} from './helpers/app.js';

const GHOST = '8e5f2c5a-7d3e-4f52-9d7c-3b7a1e9d6c11';

describe('Recepción: vista clínica de solo lectura', () => {
  let ctx: TestContext;
  let fx: Fixtures;
  beforeAll(async () => {
    ctx = await createTestContext();
    fx = new Fixtures(ctx.db);
  });
  afterAll(() => ctx.close());

  async function world() {
    const clinic = await fx.clinic('Clínica Demo (prueba)');
    const other = await fx.clinic('Otra clínica (prueba)');
    const reception = await actorIn(ctx, fx, 'RECEPTIONIST', { clinicId: clinic.id });
    const admin = await actorIn(ctx, fx, 'CLINIC_ADMIN', { clinicId: clinic.id });
    const cashier = await actorIn(ctx, fx, 'CASHIER', { clinicId: clinic.id });
    const otherReception = await actorIn(ctx, fx, 'RECEPTIONIST', { clinicId: other.id });
    const { id: patientId } = await createPatient(ctx, reception.token, { lastName: uniq('Apellido') });
    return { clinic, reception, admin, cashier, otherReception, patientId };
  }
  const get = (t: string, patientId: string, path: string) =>
    ctx.http().get(`/v1/patients/${patientId}/clinical${path}`).set(bearer(t));

  it('lee todo sin necesitar relación asistencial; no escribe; otra clínica 404', async () => {
    const w = await world();
    for (const p of ['/visits', '/history', '/alerts', '/diagnoses', '/procedures', '/odontogram', '/odontogram/versions'])
      expect((await get(w.reception.token, w.patientId, p)).status, p).toBe(200);
    expect(
      (await ctx.http().get(`/v1/patients/${w.patientId}/clinical-summary`).set(bearer(w.reception.token))).status,
    ).toBe(200);
    for (const p of ['/visits', '/history'])
      expect((await get(w.reception.token, GHOST, p)).status, p).toBe(404);
    for (const p of ['/visits', '/history', '/odontogram'])
      expect((await get(w.otherReception.token, w.patientId, p)).status, p).toBe(404);
    for (const [p, body] of [
      ['/visits', { reason: 'Motivo' }],
      ['/history', {}],
      ['/alerts', {}],
      ['/odontogram/draft', {}],
    ] as const)
      expect(
        (await ctx.http().post(`/v1/patients/${w.patientId}/clinical${p}`).set(bearer(w.reception.token)).send(body)).status,
        p,
      ).toBe(403);
  });

  it('queda auditado como lectura VIEW, sin contenido clínico', async () => {
    const w = await world();
    await get(w.reception.token, w.patientId, '/history').expect(200);
    const rows = await ctx.db.auditLog.findMany({
      where: { patientId: w.patientId, action: 'CLINICAL_RECORD_VIEWED' },
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).toContain('VIEW');
  });

  it('caja sigue sin acceso clínico (403 igual exista o no)', async () => {
    const w = await world();
    expect((await get(w.cashier.token, w.patientId, '/history')).status).toBe(403);
    expect((await get(w.cashier.token, GHOST, '/history')).status).toBe(403);
  });
});
