import {
  actorIn,
  assignCare,
  bearer,
  createPatient,
  createTestContext,
  devOutbox,
  Fixtures,
  loginInContext,
  makePdf,
  type TestContext,
  uniq,
} from './helpers/app.js';

const ITEM = { medication: 'Amoxicilina 500 mg', dose: '1 cápsula', frequency: 'Cada 8 horas', duration: '7 días', instructions: 'Después de las comidas' };

describe('Recetas y archivos clínicos del paciente', () => {
  let ctx: TestContext;
  let fx: Fixtures;
  beforeAll(async () => {
    ctx = await createTestContext();
    fx = new Fixtures(ctx.db);
  });
  afterAll(() => ctx.close());

  async function world() {
    const clinic = await fx.clinic();
    const branch = await fx.branch(clinic.id);
    const admin = await actorIn(ctx, fx, 'CLINIC_ADMIN', { clinicId: clinic.id });
    const reception = await actorIn(ctx, fx, 'RECEPTIONIST', { clinicId: clinic.id });
    const cashier = await actorIn(ctx, fx, 'CASHIER', { clinicId: clinic.id });
    const mkDentist = async () => {
      const user = await fx.user();
      await fx.assign(user.id, 'DENTIST', { clinicId: clinic.id, branchId: branch.id });
      return { user, token: await loginInContext(ctx, user.email, { clinicId: clinic.id, branchId: branch.id }) };
    };
    const dentist = await mkDentist();
    const other = await mkDentist();
    const { id: patientId } = await createPatient(ctx, reception.token, { lastName: uniq('Apellido') });
    await assignCare(ctx, reception.token, patientId, dentist.user.id);
    return { clinic, admin, reception, cashier, dentist, other, patientId };
  }
  type W = Awaited<ReturnType<typeof world>>;
  const rx = (w: W) => `/v1/patients/${w.patientId}/prescriptions`;
  const create = (w: W, token = w.dentist.token, body: object = { items: [ITEM], diagnosis: 'Infección' }) =>
    ctx.http().post(rx(w)).set(bearer(token)).send(body);

  describe('recetas', () => {
    it('el odontólogo crea, lista, edita y elimina sin necesidad de una visita abierta', async () => {
      const w = await world();
      const created = await create(w).expect(201);
      expect(created.body).toMatchObject({ number: 'RX-000001', visitId: null, status: 'ACTIVE', diagnosis: 'Infección' });
      expect(created.body.items).toEqual([{ medication: 'Amoxicilina 500 mg', dose: '1 cápsula', frequency: 'Cada 8 horas', duration: '7 días', instructions: 'Después de las comidas' }]);

      const second = await create(w, w.dentist.token, { items: [{ medication: 'Ibuprofeno' }] }).expect(201);
      expect(second.body.number).toBe('RX-000002');

      const list = await ctx.http().get(rx(w)).set(bearer(w.dentist.token)).expect(200);
      expect(list.body).toHaveLength(2);

      const edited = await ctx.http().put(`${rx(w)}/${created.body.id}`).set(bearer(w.dentist.token)).send({ items: [{ medication: 'Paracetamol 1 g' }, { medication: 'Clorhexidina' }], notes: 'Reposo' }).expect(200);
      expect(edited.body.items.map((i: { medication: string }) => i.medication)).toEqual(['Paracetamol 1 g', 'Clorhexidina']);
      expect(edited.body).toMatchObject({ diagnosis: null, notes: 'Reposo', number: 'RX-000001' });

      await ctx.http().post(`${rx(w)}/${created.body.id}/delete`).set(bearer(w.dentist.token)).send({ reason: 'no' }).expect(400);
      const del = await ctx.http().post(`${rx(w)}/${created.body.id}/delete`).set(bearer(w.dentist.token)).send({ reason: 'Emitida por error' }).expect(200);
      expect(del.body).toMatchObject({ status: 'DELETED', deleteReason: 'Emitida por error' });
      const after = await ctx.http().get(rx(w)).set(bearer(w.dentist.token)).expect(200);
      expect(after.body.map((r: { id: string }) => r.id)).toEqual([second.body.id]);
      const withDeleted = await ctx.http().get(`${rx(w)}?includeDeleted=true`).set(bearer(w.dentist.token)).expect(200);
      expect(withDeleted.body).toHaveLength(2);
      // una receta eliminada no se edita ni se exporta
      await ctx.http().put(`${rx(w)}/${created.body.id}`).set(bearer(w.dentist.token)).send({ items: [ITEM] }).expect(409);
      await ctx.http().get(`${rx(w)}/${created.body.id}/pdf`).set(bearer(w.dentist.token)).expect(404);
    });

    it('valida el contenido y la atención vinculada', async () => {
      const w = await world();
      await create(w, w.dentist.token, { items: [] }).expect(400);
      await create(w, w.dentist.token, { items: [{ medication: '' }] }).expect(400);
      await create(w, w.dentist.token, { items: [ITEM], visitId: '8e5f2c5a-7d3e-4f52-9d7c-3b7a1e9d6c11' }).expect(404);
      const visit = (await ctx.http().post(`/v1/patients/${w.patientId}/clinical/visits`).set(bearer(w.dentist.token)).send({ reason: 'Control' }).expect(201)).body as { id: string };
      const withVisit = await create(w, w.dentist.token, { items: [ITEM], visitId: visit.id }).expect(201);
      expect(withVisit.body.visitId).toBe(visit.id);
    });

    it('sin relación asistencial no hay acceso; recepción y caja no escriben; la edición es del autor o de la administración', async () => {
      const w = await world();
      const r = (await create(w).expect(201)).body as { id: string };
      await create(w, w.other.token).expect(403);
      await ctx.http().get(rx(w)).set(bearer(w.other.token)).expect(403);
      await create(w, w.reception.token).expect(403);
      await ctx.http().get(rx(w)).set(bearer(w.reception.token)).expect(200); // solo lectura
      await ctx.http().get(rx(w)).set(bearer(w.cashier.token)).expect(403);
      await ctx.http().put(`${rx(w)}/${r.id}`).set(bearer(w.other.token)).send({ items: [ITEM] }).expect(403);
      await ctx.http().put(`${rx(w)}/${r.id}`).set(bearer(w.admin.token)).send({ items: [ITEM] }).expect(200);
    });

    it('un paciente de otra clínica responde 404', async () => {
      const w = await world();
      const w2 = await world();
      await ctx.http().get(`/v1/patients/${w2.patientId}/prescriptions`).set(bearer(w.admin.token)).expect(404);
    });

    it('el listado general muestra al odontólogo solo sus recetas y a la administración todas', async () => {
      const w = await world();
      await create(w).expect(201);
      const mine = await ctx.http().get('/v1/prescriptions').set(bearer(w.dentist.token)).expect(200);
      expect(mine.body).toHaveLength(1);
      expect(mine.body[0].patientName).toBeTruthy();
      expect((await ctx.http().get('/v1/prescriptions').set(bearer(w.other.token)).expect(200)).body).toHaveLength(0);
      expect((await ctx.http().get('/v1/prescriptions').set(bearer(w.admin.token)).expect(200)).body).toHaveLength(1);
      await ctx.http().get('/v1/prescriptions').set(bearer(w.cashier.token)).expect(403);
    });

    it('descarga el PDF y lo audita sin guardar medicamentos', async () => {
      const w = await world();
      const r = (await create(w).expect(201)).body as { id: string };
      const pdf = await ctx.http().get(`${rx(w)}/${r.id}/pdf`).set(bearer(w.dentist.token)).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); }).expect(200);
      expect(pdf.headers['content-type']).toContain('application/pdf');
      expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
      const rows = await ctx.db.auditLog.findMany({ where: { patientId: w.patientId, action: { in: ['PRESCRIPTION_CREATED', 'PRESCRIPTION_EXPORTED'] } } });
      expect(rows.map((x) => x.action).sort()).toEqual(['PRESCRIPTION_CREATED', 'PRESCRIPTION_EXPORTED']);
      expect(JSON.stringify(rows)).not.toContain('Amoxicilina');
    });

    it('envía el PDF por correo al destino indicado y registra el envío', async () => {
      const w = await world();
      const r = (await create(w).expect(201)).body as { id: string };
      await ctx.http().post(`${rx(w)}/${r.id}/email`).set(bearer(w.dentist.token)).send({ to: 'no-es-correo' }).expect(400);
      // sin correo en el paciente ni destino explícito
      await ctx.http().post(`${rx(w)}/${r.id}/email`).set(bearer(w.dentist.token)).send({}).expect(422);
      const to = `${uniq('paciente')}@example.com`;
      const sent = await ctx.http().post(`${rx(w)}/${r.id}/email`).set(bearer(w.dentist.token)).send({ to }).expect(200);
      expect(sent.body).toEqual({ sent: true, to, simulated: true });
      const mail = devOutbox(ctx).outbox.find((m) => m.type === 'prescription' && m.to === to);
      expect(mail).toBeTruthy();
      const got = await ctx.http().get(`${rx(w)}/${r.id}`).set(bearer(w.dentist.token)).expect(200);
      expect(got.body.lastEmailedAt).toBeTruthy();
      const audit = await ctx.db.auditLog.findFirstOrThrow({ where: { patientId: w.patientId, action: 'PRESCRIPTION_EMAILED' } });
      expect(JSON.stringify(audit.summary)).not.toContain(to);
      await ctx.http().post(`${rx(w)}/${r.id}/email`).set(bearer(w.other.token)).send({ to }).expect(403);
    });
  });

  describe('archivos clínicos (radiografías, fotos, estudios)', () => {
    const up = (token: string, patientId: string, category: string) =>
      ctx.http().post(`/v1/patients/${patientId}/attachments`).set(bearer(token)).field('category', category).attach('file', makePdf(), { filename: 'rx.pdf', contentType: 'application/pdf' });

    it('el odontólogo con relación sube y descarga una radiografía; sin relación no', async () => {
      const w = await world();
      const res = await up(w.dentist.token, w.patientId, 'XRAY').expect(201);
      expect(res.body.category).toBe('XRAY');
      await ctx.http().get(`/v1/patients/${w.patientId}/attachments/${res.body.id}/download`).set(bearer(w.dentist.token)).expect(200);
      await up(w.other.token, w.patientId, 'XRAY').expect(403);
      await ctx.http().get(`/v1/patients/${w.patientId}/attachments/${res.body.id}/download`).set(bearer(w.other.token)).expect(403);
    });

    it('recepción solo ve (no sube) los clínicos; caja no los ve; los administrativos siguen igual', async () => {
      const w = await world();
      const xray = (await up(w.dentist.token, w.patientId, 'XRAY').expect(201)).body as { id: string };
      await up(w.reception.token, w.patientId, 'XRAY').expect(403);
      await up(w.reception.token, w.patientId, 'OTHER_ADMINISTRATIVE').expect(201);
      const seenByReception = await ctx.http().get(`/v1/patients/${w.patientId}/attachments`).set(bearer(w.reception.token)).expect(200);
      expect(seenByReception.body.map((a: { id: string }) => a.id)).toContain(xray.id);
      const seenByOther = await ctx.http().get(`/v1/patients/${w.patientId}/attachments`).set(bearer(w.other.token)).expect(200);
      expect(seenByOther.body.map((a: { category: string }) => a.category)).not.toContain('XRAY');
      await ctx.http().post(`/v1/patients/${w.patientId}/attachments/${xray.id}/remove`).set(bearer(w.reception.token)).send({ reason: 'Prueba de baja' }).expect(403);
      await ctx.http().post(`/v1/patients/${w.patientId}/attachments/${xray.id}/remove`).set(bearer(w.dentist.token)).send({ reason: 'Subida por error' }).expect(200);
    });
  });
});
