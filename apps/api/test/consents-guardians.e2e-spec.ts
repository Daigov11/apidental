import {
  type Actor,
  actorIn,
  bearer,
  createPatient,
  createTestContext,
  dni,
  Fixtures,
  mobile,
  type TestContext,
  uniq,
  yearsAgo,
} from './helpers/app.js';

describe('Representantes y consentimientos', () => {
  let ctx: TestContext;
  let fx: Fixtures;
  beforeAll(async () => {
    ctx = await createTestContext();
    fx = new Fixtures(ctx.db);
  });
  afterAll(() => ctx.close());

  async function world() {
    const a = await fx.clinic();
    const b = await fx.clinic();
    const [admin, reception, dentist, assistant, cashier] = (await Promise.all(
      ['CLINIC_ADMIN', 'RECEPTIONIST', 'DENTIST', 'ASSISTANT', 'CASHIER'].map((r) => actorIn(ctx, fx, r, { clinicId: a.id })),
    )) as [Actor, Actor, Actor, Actor, Actor];
    const adminB = await actorIn(ctx, fx, 'CLINIC_ADMIN', { clinicId: b.id });
    return { a, b, admin, reception, dentist, assistant, cashier, adminB };
  }
  const guardianBody = (extra: object = {}) => ({
    relationship: 'MOTHER',
    guardian: { firstName: 'Marta', lastName: uniq('Rios'), identifierType: 'DNI', identifierNumber: dni(), mobile: mobile() },
    ...extra,
  });
  const consentBody = (extra: object = {}) => ({
    type: 'CLINICAL',
    documentTitle: 'Consentimiento informado general',
    documentVersion: 'v1.0',
    grantedBy: 'PATIENT',
    ...extra,
  });
  const auditOf = (patientId: string, action: string) => ctx.db.auditLog.findMany({ where: { patientId, action } });

  describe('representantes / apoderados', () => {
    it('vincula un representante nuevo a un menor y quita la advertencia', async () => {
      const w = await world();
      const { id } = await createPatient(ctx, w.reception.token, { birthDate: yearsAgo(7) });
      const res = await ctx.http().post(`/v1/patients/${id}/guardians`).set(bearer(w.reception.token)).send(guardianBody()).expect(201);
      expect(res.body).toMatchObject({ relationship: 'MOTHER', isPrimary: true, status: 'ACTIVE', guardian: { firstName: 'Marta' } });
      expect(res.body.guardian.identifierNumber).toMatch(/^\d{8}$/);

      const get = await ctx.http().get(`/v1/patients/${id}`).set(bearer(w.admin.token)).expect(200);
      expect(get.body).toMatchObject({ guardianCount: 1, warnings: ['CLINICAL_CONSENT_MISSING'] });
      const list = await ctx.http().get(`/v1/patients/${id}/guardians`).set(bearer(w.dentist.token)).expect(200);
      expect(list.body).toHaveLength(1);
      expect((await auditOf(id, 'PATIENT_GUARDIAN_LINKED'))).toHaveLength(1);
      expect((await auditOf(id, 'PATIENT_GUARDIANS_VIEWED'))).toHaveLength(1);
    });

    it('reutiliza un representante para hermanos y lo encuentra por búsqueda (documento enmascarado)', async () => {
      const w = await world();
      const { id: child1 } = await createPatient(ctx, w.reception.token, { birthDate: yearsAgo(5) });
      const { id: child2 } = await createPatient(ctx, w.reception.token, { birthDate: yearsAgo(9) });
      const body = guardianBody();
      const first = await ctx.http().post(`/v1/patients/${child1}/guardians`).set(bearer(w.reception.token)).send(body).expect(201);
      const guardianId = first.body.guardian.id as string;

      const search = await ctx.http().get(`/v1/guardians?search=${encodeURIComponent(body.guardian.lastName)}`).set(bearer(w.admin.token)).expect(200);
      expect(search.body).toEqual([expect.objectContaining({ id: guardianId, identifierNumber: `*****${body.guardian.identifierNumber.slice(-3)}` })]);

      const second = await ctx.http().post(`/v1/patients/${child2}/guardians`).set(bearer(w.reception.token)).send({ relationship: 'MOTHER', guardianId }).expect(201);
      expect(second.body.guardian.id).toBe(guardianId);
      expect(await ctx.db.guardian.count({ where: { id: guardianId } })).toBe(1);
      await ctx.http().post(`/v1/patients/${child2}/guardians`).set(bearer(w.reception.token)).send({ relationship: 'MOTHER', guardianId }).expect(409);
    });

    it('valida la solicitud: exactamente guardianId o guardian; documento repetido sugiere reutilizar', async () => {
      const w = await world();
      const { id } = await createPatient(ctx, w.reception.token, { birthDate: yearsAgo(6) });
      const post = (body: object) => ctx.http().post(`/v1/patients/${id}/guardians`).set(bearer(w.reception.token)).send(body);
      await post({ relationship: 'MOTHER' }).expect(400);
      await post(guardianBody({ guardianId: '8e5f2c5a-7d3e-4f52-9d7c-3b7a1e9d6c11' })).expect(400);
      await post({ relationship: 'MOTHER', guardianId: '8e5f2c5a-7d3e-4f52-9d7c-3b7a1e9d6c11' }).expect(404);
      await post(guardianBody({ relationship: 'ABUELO' })).expect(400);
      await post({ relationship: 'FATHER', guardian: { firstName: 'X', lastName: 'Y', identifierType: 'DNI' } }).expect(400);

      const body = guardianBody();
      await post(body).expect(201);
      const { id: other } = await createPatient(ctx, w.reception.token, { birthDate: yearsAgo(4) });
      const dup = await ctx.http().post(`/v1/patients/${other}/guardians`).set(bearer(w.reception.token)).send({ ...body, guardian: { ...body.guardian, firstName: 'Otra' } }).expect(409);
      expect(dup.body.code).toBe('GUARDIAN_EXISTS');
      expect(dup.body.existingGuardianId).toBeTruthy();
    });

    it('un solo representante principal; finalizar el vínculo exige motivo y conserva el historial', async () => {
      const w = await world();
      const { id } = await createPatient(ctx, w.reception.token, { birthDate: yearsAgo(6) });
      const post = (body: object) => ctx.http().post(`/v1/patients/${id}/guardians`).set(bearer(w.reception.token)).send(body);
      const mother = await post(guardianBody()).expect(201);
      await post(guardianBody({ relationship: 'FATHER', isPrimary: true })).expect(409);
      const father = await post(guardianBody({ relationship: 'FATHER' })).expect(201);
      expect(father.body.isPrimary).toBe(false);

      const end = (linkId: string, body: object) => ctx.http().post(`/v1/patients/${id}/guardians/${linkId}/end`).set(bearer(w.reception.token)).send(body);
      await end(mother.body.id, {}).expect(400);
      await end(mother.body.id, { reason: 'Pérdida de la patria potestad' }).expect(200);
      await end(mother.body.id, { reason: 'otra vez' }).expect(409);
      const all = await ctx.http().get(`/v1/patients/${id}/guardians`).set(bearer(w.admin.token)).expect(200);
      expect(all.body.map((g: { status: string }) => g.status).sort()).toEqual(['ACTIVE', 'ENDED']);
      expect(await ctx.db.patientGuardian.count({ where: { patientId: id } })).toBe(2);
    });

    it('un representante de otra clínica no puede vincularse; los roles de solo lectura no escriben; caja no los ve', async () => {
      const w = await world();
      const { id: patientB } = await createPatient(ctx, w.adminB.token, { birthDate: yearsAgo(6) });
      const foreignGuardian = await ctx.http().post(`/v1/patients/${patientB}/guardians`).set(bearer(w.adminB.token)).send(guardianBody()).expect(201);
      const { id } = await createPatient(ctx, w.reception.token, { birthDate: yearsAgo(6) });
      await ctx.http().post(`/v1/patients/${id}/guardians`).set(bearer(w.reception.token)).send({ relationship: 'MOTHER', guardianId: foreignGuardian.body.guardian.id }).expect(404);
      await ctx.http().post(`/v1/patients/${id}/guardians`).set(bearer(w.dentist.token)).send(guardianBody()).expect(403);
      await ctx.http().get(`/v1/patients/${id}/guardians`).set(bearer(w.cashier.token)).expect(403);
      await ctx.http().get('/v1/guardians?search=algo').set(bearer(w.cashier.token)).expect(403);
      const search = await ctx.http().get(`/v1/guardians?search=${foreignGuardian.body.guardian.lastName}`).set(bearer(w.admin.token)).expect(200);
      expect(search.body).toEqual([]); // la búsqueda no cruza clínicas
    });
  });

  describe('consentimientos', () => {
    it('registra un consentimiento con tipo, estado, fecha, versión/documento y autor', async () => {
      const w = await world();
      const { id } = await createPatient(ctx, w.reception.token, { birthDate: yearsAgo(30) });
      const res = await ctx.http().post(`/v1/patients/${id}/consents`).set(bearer(w.reception.token)).send(consentBody({ notes: 'Firmado en recepción' })).expect(201);
      expect(res.body).toMatchObject({
        type: 'CLINICAL', status: 'GRANTED', documentTitle: 'Consentimiento informado general', documentVersion: 'v1.0',
        grantedBy: 'PATIENT', notes: 'Firmado en recepción', attachmentCount: 0, revokedAt: null,
      });
      expect(Date.parse(res.body.grantedAt)).not.toBeNaN();
      expect((await ctx.db.patientConsent.findUniqueOrThrow({ where: { id: res.body.id } })).createdById).toBe(w.reception.user.id);
      const [log] = await auditOf(id, 'CONSENT_GRANTED');
      expect(log).toMatchObject({ userId: w.reception.user.id, entityId: res.body.id });
      expect(log!.summary).toMatchObject({ type: 'CLINICAL', documentVersion: 'v1.0', grantedBy: 'PATIENT' });
    });

    it('los tres tipos son independientes y coexisten; no se duplica uno vigente del mismo tipo', async () => {
      const w = await world();
      const { id } = await createPatient(ctx, w.reception.token);
      const post = (type: string) => ctx.http().post(`/v1/patients/${id}/consents`).set(bearer(w.reception.token)).send(consentBody({ type, documentTitle: `Doc ${type}` }));
      await post('CLINICAL').expect(201);
      await post('LOYALTY').expect(201);
      await post('MARKETING').expect(201);
      const dup = await post('MARKETING').expect(409);
      expect(dup.body.message).toMatch(/MARKETING/);
      const list = await ctx.http().get(`/v1/patients/${id}/consents`).set(bearer(w.dentist.token)).expect(200);
      expect(list.body.map((c: { type: string }) => c.type).sort()).toEqual(['CLINICAL', 'LOYALTY', 'MARKETING']);
    });

    it('revocar exige motivo, no borra el registro, queda auditado y permite registrar una nueva versión', async () => {
      const w = await world();
      const { id } = await createPatient(ctx, w.reception.token);
      const granted = await ctx.http().post(`/v1/patients/${id}/consents`).set(bearer(w.reception.token)).send(consentBody({ type: 'MARKETING' })).expect(201);
      const revoke = (body: object) => ctx.http().post(`/v1/patients/${id}/consents/${granted.body.id}/revoke`).set(bearer(w.reception.token)).send(body);

      await revoke({}).expect(400);
      await revoke({ reason: 'no' }).expect(400);
      const res = await revoke({ reason: 'La paciente retiró su autorización' }).expect(200);
      expect(res.body).toMatchObject({ status: 'REVOKED', revocationReason: 'La paciente retiró su autorización' });
      expect(res.body.revokedAt).toBeTruthy();
      await revoke({ reason: 'otra vez' }).expect(409);

      const row = await ctx.db.patientConsent.findUniqueOrThrow({ where: { id: granted.body.id } });
      expect(row).toMatchObject({ status: 'REVOKED', revokedById: w.reception.user.id, documentVersion: 'v1.0' });
      const [log] = await auditOf(id, 'CONSENT_REVOKED');
      expect(log!.summary).toMatchObject({ type: 'MARKETING', reason: 'La paciente retiró su autorización' });

      // nuevo consentimiento del mismo tipo: registro independiente; el anterior sigue en el historial
      const again = await ctx.http().post(`/v1/patients/${id}/consents`).set(bearer(w.reception.token)).send(consentBody({ type: 'MARKETING', documentVersion: 'v2.0' })).expect(201);
      expect(again.body.id).not.toBe(granted.body.id);
      const list = await ctx.http().get(`/v1/patients/${id}/consents`).set(bearer(w.admin.token)).expect(200);
      expect(list.body.map((c: { status: string }) => c.status).sort()).toEqual(['GRANTED', 'REVOKED']);
    });

    it('un menor no consiente por sí mismo: lo hace un representante vigente del propio paciente', async () => {
      const w = await world();
      const { id } = await createPatient(ctx, w.reception.token, { birthDate: yearsAgo(10) });
      const post = (body: object) => ctx.http().post(`/v1/patients/${id}/consents`).set(bearer(w.reception.token)).send(consentBody(body));
      await post({ grantedBy: 'PATIENT' }).expect(400);
      await post({ grantedBy: 'GUARDIAN' }).expect(400); // falta guardianId

      const link = await ctx.http().post(`/v1/patients/${id}/guardians`).set(bearer(w.reception.token)).send(guardianBody()).expect(201);
      const ok = await post({ grantedBy: 'GUARDIAN', guardianId: link.body.guardian.id }).expect(201);
      expect(ok.body).toMatchObject({ grantedBy: 'GUARDIAN', guardianId: link.body.guardian.id });

      // un representante que no está vinculado a ESTE paciente no sirve
      const { id: other } = await createPatient(ctx, w.reception.token, { birthDate: yearsAgo(10) });
      const stranger = await ctx.http().post(`/v1/patients/${other}/guardians`).set(bearer(w.reception.token)).send(guardianBody()).expect(201);
      await post({ type: 'LOYALTY', grantedBy: 'GUARDIAN', guardianId: stranger.body.guardian.id }).expect(400);
      // vínculo finalizado ya no habilita
      await ctx.http().post(`/v1/patients/${id}/guardians/${link.body.id}/end`).set(bearer(w.reception.token)).send({ reason: 'Fin de representación' }).expect(200);
      await post({ type: 'LOYALTY', grantedBy: 'GUARDIAN', guardianId: link.body.guardian.id }).expect(400);
    });

    it('un adulto no puede usar guardianId con grantedBy=PATIENT', async () => {
      const w = await world();
      const { id } = await createPatient(ctx, w.reception.token, { birthDate: yearsAgo(40) });
      await ctx.http().post(`/v1/patients/${id}/consents`).set(bearer(w.reception.token)).send(consentBody({ guardianId: '8e5f2c5a-7d3e-4f52-9d7c-3b7a1e9d6c11' })).expect(400);
    });

    it('valida fechas y campos del consentimiento', async () => {
      const w = await world();
      const { id } = await createPatient(ctx, w.reception.token);
      const post = (body: object) => ctx.http().post(`/v1/patients/${id}/consents`).set(bearer(w.reception.token)).send(consentBody(body));
      await post({ grantedAt: '2999-01-01T00:00:00Z' }).expect(400);
      await post({ grantedAt: 'ayer' }).expect(400);
      await post({ type: 'OTRO' }).expect(400);
      await post({ documentVersion: '' }).expect(400);
      await post({ status: 'REVOKED' }).expect(400);
      const ok = await post({ grantedAt: '2026-01-15T10:30:00-05:00' }).expect(201);
      expect(ok.body.grantedAt).toBe('2026-01-15T15:30:00.000Z');
    });

    it('permisos: administración y recepción gestionan; odontólogo y asistente leen; caja no accede', async () => {
      const w = await world();
      const { id } = await createPatient(ctx, w.reception.token);
      const granted = await ctx.http().post(`/v1/patients/${id}/consents`).set(bearer(w.admin.token)).send(consentBody()).expect(201);
      for (const actor of [w.dentist, w.assistant]) {
        await ctx.http().get(`/v1/patients/${id}/consents`).set(bearer(actor.token)).expect(200);
        await ctx.http().post(`/v1/patients/${id}/consents`).set(bearer(actor.token)).send(consentBody({ type: 'LOYALTY' })).expect(403);
        await ctx.http().post(`/v1/patients/${id}/consents/${granted.body.id}/revoke`).set(bearer(actor.token)).send({ reason: 'intento' }).expect(403);
      }
      await ctx.http().get(`/v1/patients/${id}/consents`).set(bearer(w.cashier.token)).expect(403);
      await ctx.http().post(`/v1/patients/${id}/consents`).set(bearer(w.cashier.token)).send(consentBody({ type: 'LOYALTY' })).expect(403);
      await ctx.http().post(`/v1/patients/${id}/consents/${granted.body.id}/revoke`).set(bearer(w.reception.token)).send({ reason: 'Solicitud del paciente' }).expect(200);
    });

    it('aislamiento: la clínica B no ve ni revoca consentimientos de la A', async () => {
      const w = await world();
      const { id } = await createPatient(ctx, w.reception.token);
      const granted = await ctx.http().post(`/v1/patients/${id}/consents`).set(bearer(w.reception.token)).send(consentBody()).expect(201);
      await ctx.http().get(`/v1/patients/${id}/consents`).set(bearer(w.adminB.token)).expect(404);
      await ctx.http().post(`/v1/patients/${id}/consents`).set(bearer(w.adminB.token)).send(consentBody({ type: 'LOYALTY' })).expect(404);
      await ctx.http().post(`/v1/patients/${id}/consents/${granted.body.id}/revoke`).set(bearer(w.adminB.token)).send({ reason: 'intento ajeno' }).expect(404);
      expect((await ctx.db.patientConsent.findUniqueOrThrow({ where: { id: granted.body.id } })).status).toBe('GRANTED');
    });

    it('un paciente inactivo no recibe consentimientos nuevos, pero sus consentimientos sí pueden revocarse', async () => {
      const w = await world();
      const { id } = await createPatient(ctx, w.reception.token);
      const granted = await ctx.http().post(`/v1/patients/${id}/consents`).set(bearer(w.reception.token)).send(consentBody({ type: 'MARKETING' })).expect(201);
      await ctx.http().post(`/v1/patients/${id}/deactivate`).set(bearer(w.reception.token)).send({ reason: 'Paciente inactivo' }).expect(200);
      await ctx.http().post(`/v1/patients/${id}/consents`).set(bearer(w.reception.token)).send(consentBody({ type: 'LOYALTY' })).expect(409);
      await ctx.http().post(`/v1/patients/${id}/consents/${granted.body.id}/revoke`).set(bearer(w.reception.token)).send({ reason: 'Baja de marketing' }).expect(200);
    });

    it('listar consentimientos queda auditado', async () => {
      const w = await world();
      const { id } = await createPatient(ctx, w.reception.token);
      await ctx.http().get(`/v1/patients/${id}/consents`).set(bearer(w.dentist.token)).expect(200);
      const [log] = await auditOf(id, 'CONSENT_LISTED');
      expect(log).toMatchObject({ userId: w.dentist.user.id, clinicId: w.a.id });
    });
  });
});
