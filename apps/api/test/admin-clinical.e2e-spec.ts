import {
  actorIn,
  bearer,
  createPatient,
  createTestContext,
  Fixtures,
  uniq,
  type TestContext,
} from './helpers/app.js';

describe('Administración: acceso clínico total auditado (clinical:admin)', () => {
  let ctx: TestContext;
  let fx: Fixtures;
  beforeAll(async () => {
    ctx = await createTestContext();
    fx = new Fixtures(ctx.db);
  });
  afterAll(() => ctx.close());

  async function world() {
    const clinic = await fx.clinic('Clínica Demo (prueba)');
    const branch = await fx.branch(clinic.id);
    const reception = await actorIn(ctx, fx, 'RECEPTIONIST', { clinicId: clinic.id });
    const admin = await actorIn(ctx, fx, 'CLINIC_ADMIN', { clinicId: clinic.id, branchId: branch.id });
    const { id: patientId } = await createPatient(ctx, reception.token, { lastName: uniq('Apellido') });
    return { clinic, admin, reception, patientId };
  }
  const base = (id: string) => `/v1/patients/${id}/clinical`;

  it('lee historia, odontograma y resumen de un paciente sin relación asistencial, y queda auditado como admin_access', async () => {
    const w = await world();
    for (const p of ['/visits', '/history', '/alerts', '/diagnoses', '/procedures', '/odontogram', '/odontogram/versions'])
      expect((await ctx.http().get(base(w.patientId) + p).set(bearer(w.admin.token))).status, p).toBe(200);
    const sum = await ctx.http().get(`/v1/patients/${w.patientId}/clinical-summary`).set(bearer(w.admin.token));
    expect(sum.status).toBe(200);
    expect(sum.body.access).toMatchObject({ level: 'FULL', via: 'admin_access' });
    const rows = await ctx.db.auditLog.findMany({
      where: { patientId: w.patientId, userId: w.admin.user.id, action: 'CLINICAL_RECORD_VIEWED' },
    });
    expect(rows.length).toBeGreaterThan(0);
  });

  it('escribe antecedentes y abre un borrador de odontograma sin relación asistencial; queda auditado', async () => {
    const w = await world();
    const entry = await ctx
      .http()
      .post(base(w.patientId) + '/history')
      .set(bearer(w.admin.token))
      .send({
        kind: 'ALLERGY',
        label: uniq('Penicilina-'),
        condition: 'Urticaria',
        category: 'Medicamento',
        severity: 'SEVERE',
        isCritical: true,
        source: 'PATIENT',
        reason: 'Registro por administración',
      });
    expect(entry.status, JSON.stringify(entry.body)).toBe(201);
    const draft = await ctx.http().post(base(w.patientId) + '/odontogram/draft').set(bearer(w.admin.token)).send({});
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    const writes = await ctx.db.auditLog.findMany({
      where: { patientId: w.patientId, userId: w.admin.user.id, action: 'CLINICAL_WRITE_AUTHORIZED' },
    });
    expect(writes.length).toBeGreaterThanOrEqual(2);
  });

  it('no abre visitas (son del odontólogo responsable) ni obtiene read_all', async () => {
    const w = await world();
    const v = await ctx.http().post(base(w.patientId) + '/visits').set(bearer(w.admin.token)).send({ reason: 'Motivo' });
    expect(v.status).toBe(403);
    const me = await ctx.http().get('/v1/auth/me').set(bearer(w.admin.token)).expect(200);
    expect(me.body.permissions).not.toContain('clinical:read_all');
  });
});
