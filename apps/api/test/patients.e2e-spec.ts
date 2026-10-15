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

describe('Pacientes', () => {
  let ctx: TestContext;
  let fx: Fixtures;
  beforeAll(async () => {
    ctx = await createTestContext();
    fx = new Fixtures(ctx.db);
  });
  afterAll(() => ctx.close());

  /** Dos clínicas, con sus sedes y un actor por rol en la clínica A. */
  async function world() {
    const a = await fx.clinic();
    const b = await fx.clinic();
    const a1 = await fx.branch(a.id);
    const a2 = await fx.branch(a.id);
    const [admin, reception, dentist, assistant, cashier] = await Promise.all(
      ['CLINIC_ADMIN', 'RECEPTIONIST', 'DENTIST', 'ASSISTANT', 'CASHIER'].map((r) => actorIn(ctx, fx, r, { clinicId: a.id })),
    ) as [Actor, Actor, Actor, Actor, Actor];
    const adminB = await actorIn(ctx, fx, 'CLINIC_ADMIN', { clinicId: b.id });
    return { a, b, a1, a2, admin, reception, dentist, assistant, cashier, adminB };
  }
  const auditOf = (patientId: string, action?: string) =>
    ctx.db.auditLog.findMany({ where: { patientId, ...(action ? { action } : {}) }, orderBy: { createdAt: 'asc' } });

  describe('alta', () => {
    it('crea un paciente con id UUID interno, sede de registro y auditoría', async () => {
      const w = await world();
      const branchReception = await actorIn(ctx, fx, 'RECEPTIONIST', { clinicId: w.a.id, branchId: w.a1.id });
      const { id, res } = await createPatient(ctx, branchReception.token);

      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(res.body.patient).toMatchObject({ status: 'ACTIVE', createdBranchId: w.a1.id, identifiers: [] });
      expect(res.body.duplicateWarnings).toEqual([]);
      const row = await ctx.db.patient.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({ clinicId: w.a.id, createdById: branchReception.user.id });

      const [log] = await auditOf(id, 'PATIENT_CREATED');
      expect(log).toMatchObject({ userId: branchReception.user.id, clinicId: w.a.id, branchId: w.a1.id, entity: 'Patient' });
    });

    it('crea con identificador, demografía y contactos normalizados', async () => {
      const w = await world();
      const number = dni();
      const { id, res } = await createPatient(ctx, w.reception.token, {
        firstName: 'María',
        lastName: 'Quispe',
        secondLastName: 'Huamán',
        birthDate: '1985-11-02',
        sex: 'FEMALE',
        identifier: { type: 'DNI', number: ` ${number.slice(0, 4)} ${number.slice(4)} ` },
        contacts: [
          { type: 'MOBILE', value: '+51 987 654 321', label: 'personal' },
          { type: 'EMAIL', value: ' Maria@Correo.PE ' },
          { type: 'ADDRESS', value: 'Av. Arequipa 123, Lima' },
        ],
      });
      expect(res.body.patient).toMatchObject({
        fullName: 'María Quispe Huamán',
        birthDate: '1985-11-02',
        sex: 'FEMALE',
        identifiers: [{ type: 'DNI', number }],
        primaryMobile: '987654321',
        primaryEmail: 'maria@correo.pe',
      });
      expect(res.body.patient.contacts).toHaveLength(3);
      expect(res.body.patient.contacts.every((c: { isPrimary: boolean }) => c.isPrimary)).toBe(true);
      expect(await ctx.db.patientIdentifier.count({ where: { patientId: id, status: 'ACTIVE' } })).toBe(1);
    });

    it('valida los datos de entrada', async () => {
      const w = await world();
      const post = (body: object) => ctx.http().post('/v1/patients').set(bearer(w.reception.token)).send({ firstName: 'A', lastName: 'B', ...body });
      await post({ identifier: { type: 'DNI', number: '1234567' } }).expect(400);
      await post({ identifier: { type: 'DNI', number: '1234567a' } }).expect(400);
      await post({ identifier: { type: 'PASSPORT', number: 'ab' } }).expect(400);
      await post({ birthDate: '2999-01-01' }).expect(400);
      await post({ birthDate: '2026-02-30' }).expect(400);
      await post({ birthDate: '1850-01-01' }).expect(400);
      await post({ birthDate: '17/05/1990' }).expect(400);
      await post({ contacts: [{ type: 'EMAIL', value: 'no-es-correo' }] }).expect(400);
      await post({ contacts: [{ type: 'MOBILE', value: '12' }] }).expect(400);
      await post({ contacts: [{ type: 'MOBILE', value: '987654321', isPrimary: true }, { type: 'MOBILE', value: '912345678', isPrimary: true }] }).expect(400);
      await post({ contacts: [{ type: 'MOBILE', value: '987654321' }, { type: 'MOBILE', value: '+51987654321' }] }).expect(400);
      await post({ sex: 'ROBOT' }).expect(400);
      await ctx.http().post('/v1/patients').set(bearer(w.reception.token)).send({ lastName: 'B' }).expect(400);
    });

    it('rechaza intentar fijar campos internos (id, clinicId, autor)', async () => {
      const w = await world();
      const post = (extra: object) => ctx.http().post('/v1/patients').set(bearer(w.reception.token)).send({ firstName: 'A', lastName: 'B', ...extra });
      await post({ id: '8e5f2c5a-7d3e-4f52-9d7c-3b7a1e9d6c11' }).expect(400);
      await post({ clinicId: w.b.id }).expect(400);
      await post({ createdById: w.adminB.user.id }).expect(400);
    });

    it('un paciente de la clínica A nunca se crea en la clínica B por un parámetro del cliente', async () => {
      const w = await world();
      const { id } = await createPatient(ctx, w.reception.token);
      expect((await ctx.db.patient.findUniqueOrThrow({ where: { id } })).clinicId).toBe(w.a.id);
    });
  });

  describe('duplicados', () => {
    it('DNI repetido en la clínica => 409 con el paciente existente y NO crea duplicado', async () => {
      const w = await world();
      const number = dni();
      const { id: firstId } = await createPatient(ctx, w.reception.token, { identifier: { type: 'DNI', number } });
      const before = await ctx.db.patient.count({ where: { clinicId: w.a.id } });

      const res = await ctx.http().post('/v1/patients').set(bearer(w.admin.token)).send({
        firstName: 'Otro', lastName: 'Nombre', identifier: { type: 'DNI', number },
      }).expect(409);
      expect(res.body).toMatchObject({ code: 'IDENTIFIER_CONFLICT', existingPatient: { id: firstId } });
      expect(await ctx.db.patient.count({ where: { clinicId: w.a.id } })).toBe(before);
    });

    it('el mismo DNI en OTRA clínica es válido (la unicidad es por clínica)', async () => {
      const w = await world();
      const number = dni();
      await createPatient(ctx, w.reception.token, { identifier: { type: 'DNI', number } });
      await ctx.http().post('/v1/patients').set(bearer(w.adminB.token)).send({
        firstName: 'Ana', lastName: 'B', identifier: { type: 'DNI', number },
      }).expect(201);
    });

    it('CE y pasaporte también son únicos por clínica', async () => {
      const w = await world();
      const identifier = { type: 'CE', number: `CE${Date.now()}`.slice(0, 12) };
      await createPatient(ctx, w.reception.token, { identifier });
      await ctx.http().post('/v1/patients').set(bearer(w.reception.token)).send({ firstName: 'X', lastName: 'Y', identifier: { ...identifier, number: identifier.number.toLowerCase() } }).expect(409);
    });

    it('nombre + fecha de nacimiento iguales => advertencia HIGH sin bloquear (sin tildes ni mayúsculas)', async () => {
      const w = await world();
      const last = uniq('Perez');
      const { id: existing } = await createPatient(ctx, w.reception.token, { firstName: 'José', lastName: last, birthDate: '1990-05-17' });
      const res = await ctx.http().post('/v1/patients').set(bearer(w.reception.token)).send({
        firstName: 'JOSE', lastName: last.toUpperCase(), birthDate: '1990-05-17',
      }).expect(201);
      expect(res.body.duplicateWarnings).toEqual([
        expect.objectContaining({ patientId: existing, reasons: ['NAME_AND_BIRTHDATE'], confidence: 'HIGH' }),
      ]);
      // ambos pacientes existen: no hay fusión ni bloqueo
      expect(await ctx.db.patient.count({ where: { id: { in: [existing, res.body.patient.id] } } })).toBe(2);
    });

    it('mismo nombre sin fecha => advertencia LOW; celular compartido => LOW; correo => MEDIUM', async () => {
      const w = await world();
      const last = uniq('Rojas');
      const phone = mobile();
      const mail = `${uniq('fam')}@correo.pe`;
      const { id: p1 } = await createPatient(ctx, w.reception.token, {
        firstName: 'Luis', lastName: last, birthDate: '1980-01-01',
        contacts: [{ type: 'MOBILE', value: phone }, { type: 'EMAIL', value: mail }],
      });

      const byName = await ctx.http().post('/v1/patients').set(bearer(w.reception.token)).send({ firstName: 'Luis', lastName: last, birthDate: '1999-09-09' }).expect(201);
      expect(byName.body.duplicateWarnings[0]).toMatchObject({ patientId: p1, reasons: ['NAME'], confidence: 'LOW' });

      const byPhone = await ctx.http().post('/v1/patients').set(bearer(w.reception.token)).send({ firstName: 'Hijo', lastName: uniq('Distinto'), contacts: [{ type: 'MOBILE', value: `+51 ${phone}` }] }).expect(201);
      expect(byPhone.body.duplicateWarnings).toEqual([expect.objectContaining({ patientId: p1, reasons: ['MOBILE'], confidence: 'LOW' })]);

      const byMail = await ctx.http().post('/v1/patients').set(bearer(w.reception.token)).send({ firstName: 'Otro', lastName: uniq('Distinto'), contacts: [{ type: 'EMAIL', value: mail.toUpperCase() }] }).expect(201);
      expect(byMail.body.duplicateWarnings).toEqual([expect.objectContaining({ patientId: p1, reasons: ['EMAIL'], confidence: 'MEDIUM' })]);
    });

    it('no hay advertencias cuando nada coincide, ni cruza clínicas', async () => {
      const w = await world();
      const last = uniq('Unico');
      const phone = mobile();
      await ctx.http().post('/v1/patients').set(bearer(w.adminB.token)).send({
        firstName: 'Ana', lastName: last, birthDate: '1990-05-17', contacts: [{ type: 'MOBILE', value: phone }],
      }).expect(201);
      const res = await ctx.http().post('/v1/patients').set(bearer(w.reception.token)).send({
        firstName: 'Ana', lastName: last, birthDate: '1990-05-17', contacts: [{ type: 'MOBILE', value: phone }],
      }).expect(201);
      expect(res.body.duplicateWarnings).toEqual([]);
    });

    it('duplicate-check informa sin escribir nada', async () => {
      const w = await world();
      const number = dni();
      const last = uniq('Check');
      const { id } = await createPatient(ctx, w.reception.token, { firstName: 'Rosa', lastName: last, birthDate: '1975-03-03', identifier: { type: 'DNI', number } });
      const before = await ctx.db.patient.count({ where: { clinicId: w.a.id } });

      const res = await ctx.http().post('/v1/patients/duplicate-check').set(bearer(w.reception.token)).send({
        firstName: 'Rosa', lastName: last, birthDate: '1975-03-03', identifier: { type: 'DNI', number },
      }).expect(200);
      expect(res.body.identifierConflict).toMatchObject({ id });
      expect(res.body.possibleDuplicates[0]).toMatchObject({ patientId: id, confidence: 'HIGH' });
      expect(await ctx.db.patient.count({ where: { clinicId: w.a.id } })).toBe(before);

      const none = await ctx.http().post('/v1/patients/duplicate-check').set(bearer(w.reception.token)).send({ firstName: 'Nadie', lastName: uniq('Nada') }).expect(200);
      expect(none.body).toEqual({ identifierConflict: null, possibleDuplicates: [] });
    });

    it('GET /patients/:id/duplicates y el reporte de la clínica agrupan sin mezclar clínicas', async () => {
      const w = await world();
      const last = uniq('Grupo');
      const { id: p1 } = await createPatient(ctx, w.reception.token, { firstName: 'Eva', lastName: last, birthDate: '2001-02-02' });
      const { id: p2 } = await createPatient(ctx, w.reception.token, { firstName: 'Eva', lastName: last, birthDate: '2001-02-02' });
      await ctx.http().post('/v1/patients').set(bearer(w.adminB.token)).send({ firstName: 'Eva', lastName: last, birthDate: '2001-02-02' }).expect(201);

      const one = await ctx.http().get(`/v1/patients/${p1}/duplicates`).set(bearer(w.admin.token)).expect(200);
      expect(one.body.possibleDuplicates.map((d: { patientId: string }) => d.patientId)).toEqual([p2]);

      const report = await ctx.http().get('/v1/patients/duplicate-report').set(bearer(w.admin.token)).expect(200);
      const group = report.body.groups.find((g: { reason: string; patients: { patientId: string }[] }) =>
        g.reason === 'NAME_AND_BIRTHDATE' && g.patients.some((p) => p.patientId === p1));
      expect(group.patients.map((p: { patientId: string }) => p.patientId).sort()).toEqual([p1, p2].sort());
      expect(group.confidence).toBe('HIGH');
      // el reporte de la clínica B nunca incluye pacientes de A
      const reportB = await ctx.http().get('/v1/patients/duplicate-report').set(bearer(w.adminB.token)).expect(200);
      expect(JSON.stringify(reportB.body)).not.toContain(p1);
    });
  });

  describe('lectura, búsqueda y vistas por permiso', () => {
    it('GET /patients/:id: ficha completa para quien la puede leer; mínima para caja', async () => {
      const w = await world();
      const { id } = await createPatient(ctx, w.reception.token, {
        firstName: 'Carla', lastName: uniq('Vega'), birthDate: '1992-07-07', sex: 'FEMALE',
        identifier: { type: 'DNI', number: dni() },
        contacts: [{ type: 'MOBILE', value: mobile() }, { type: 'ADDRESS', value: 'Calle Falsa 123' }],
      });
      const full = await ctx.http().get(`/v1/patients/${id}`).set(bearer(w.dentist.token)).expect(200);
      expect(full.body).toMatchObject({ birthDate: '1992-07-07', sex: 'FEMALE', isMinor: false });
      expect(full.body.contacts).toHaveLength(2);

      const basic = await ctx.http().get(`/v1/patients/${id}`).set(bearer(w.cashier.token)).expect(200);
      expect(basic.body.identifiers).toHaveLength(1);
      expect(basic.body.primaryMobile).toBeTruthy();
      for (const hidden of ['birthDate', 'sex', 'age', 'contacts', 'createdAt', 'createdBranchId', 'guardianCount', 'statusReason']) {
        expect(basic.body).not.toHaveProperty(hidden);
      }
      expect(JSON.stringify(basic.body)).not.toMatch(/Calle Falsa|1992/);
    });

    it('no expone campos internos en ninguna respuesta de paciente', async () => {
      const w = await world();
      const { id, res } = await createPatient(ctx, w.reception.token, { contacts: [{ type: 'MOBILE', value: mobile() }] });
      const get = await ctx.http().get(`/v1/patients/${id}`).set(bearer(w.admin.token)).expect(200);
      for (const body of [res.body, get.body]) {
        expect(JSON.stringify(body)).not.toMatch(/clinicId|clinic_id|createdById|updatedById|activeKey|primaryKey|valueKey|storageKey|passwordHash/);
      }
    });

    it('un menor aparece con isMinor y la advertencia de falta de representante', async () => {
      const w = await world();
      const { id, res } = await createPatient(ctx, w.reception.token, { birthDate: yearsAgo(8) });
      expect(res.body.warnings).toEqual(['MINOR_WITHOUT_GUARDIAN']);
      const get = await ctx.http().get(`/v1/patients/${id}`).set(bearer(w.admin.token)).expect(200);
      expect(get.body).toMatchObject({ isMinor: true, age: 8, guardianCount: 0, warnings: ['MINOR_WITHOUT_GUARDIAN'] });
      const adult = await createPatient(ctx, w.reception.token, { birthDate: yearsAgo(18) });
      expect(adult.res.body.warnings).toEqual([]);
    });

    it('busca por identificador, nombre (sin tildes, parcial), teléfono, correo y nacimiento', async () => {
      const w = await world();
      const number = dni();
      const phone = mobile();
      const last = uniq('Zúñiga');
      const mail = `${uniq('busca')}@correo.pe`;
      const { id } = await createPatient(ctx, w.reception.token, {
        firstName: 'Sofía', lastName: last, birthDate: '1966-06-06',
        identifier: { type: 'DNI', number },
        contacts: [{ type: 'MOBILE', value: phone }, { type: 'EMAIL', value: mail }],
      });
      const find = async (qs: string, token = w.reception.token) =>
        (await ctx.http().get(`/v1/patients?${qs}`).set(bearer(token)).expect(200)).body as { id: string }[];

      expect((await find(`identifier=${number}`)).map((p) => p.id)).toEqual([id]);
      expect((await find(`identifier=${number}&identifierType=DNI`)).map((p) => p.id)).toEqual([id]);
      expect(await find(`identifier=${number}&identifierType=CE`)).toEqual([]);
      expect((await find(`name=${encodeURIComponent('sofia')}%20${last.toLowerCase().replace('ú', 'u').replace('ñ', 'n')}`)).map((p) => p.id)).toEqual([id]);
      expect((await find(`name=${encodeURIComponent(last.slice(0, 4))}`)).map((p) => p.id)).toContain(id);
      expect((await find(`phone=${encodeURIComponent('+51 ' + phone)}`)).map((p) => p.id)).toEqual([id]);
      expect((await find(`email=${encodeURIComponent(mail.toUpperCase())}`)).map((p) => p.id)).toEqual([id]);
      expect((await find(`birthDate=1966-06-06&name=${encodeURIComponent(last)}`)).map((p) => p.id)).toEqual([id]);
      // caja puede buscar (vista mínima)
      const asCashier = await find(`identifier=${number}`, w.cashier.token);
      expect(asCashier[0]).not.toHaveProperty('birthDate');
    });

    it('la búsqueda nunca devuelve pacientes de otra clínica', async () => {
      const w = await world();
      const number = dni();
      const last = uniq('Aislado');
      await ctx.http().post('/v1/patients').set(bearer(w.adminB.token)).send({ firstName: 'Ana', lastName: last, identifier: { type: 'DNI', number } }).expect(201);
      for (const qs of [`identifier=${number}`, `name=${last}`]) {
        const res = await ctx.http().get(`/v1/patients?${qs}`).set(bearer(w.admin.token)).expect(200);
        expect(res.body).toEqual([]);
      }
    });

    it('los pacientes se comparten entre sedes de la misma clínica', async () => {
      const w = await world();
      const r1 = await actorIn(ctx, fx, 'RECEPTIONIST', { clinicId: w.a.id, branchId: w.a1.id });
      const r2 = await actorIn(ctx, fx, 'RECEPTIONIST', { clinicId: w.a.id, branchId: w.a2.id });
      const { id } = await createPatient(ctx, r1.token);
      const res = await ctx.http().get(`/v1/patients/${id}`).set(bearer(r2.token)).expect(200);
      expect(res.body.id).toBe(id);
    });

    it('pagina con límites acotados y filtra por estado', async () => {
      const w = await world();
      const last = uniq('Pag');
      for (let i = 0; i < 3; i++) await createPatient(ctx, w.reception.token, { firstName: `N${i}`, lastName: last });
      const page = await ctx.http().get(`/v1/patients?name=${last}&limit=2`).set(bearer(w.admin.token)).expect(200);
      expect(page.body).toHaveLength(2);
      const rest = await ctx.http().get(`/v1/patients?name=${last}&limit=2&offset=2`).set(bearer(w.admin.token)).expect(200);
      expect(rest.body).toHaveLength(1);
      await ctx.http().get('/v1/patients?limit=1000').set(bearer(w.admin.token)).expect(400);
      await ctx.http().get('/v1/patients?status=ELIMINADO').set(bearer(w.admin.token)).expect(400);
    });
  });

  describe('modificación', () => {
    it('PATCH cambia datos demográficos y audita solo los nombres de campo (no los valores)', async () => {
      const w = await world();
      const { id } = await createPatient(ctx, w.reception.token, { firstName: 'Valor', lastName: 'Original', birthDate: '1990-01-01' });
      const res = await ctx.http().patch(`/v1/patients/${id}`).set(bearer(w.reception.token)).send({
        firstName: 'Nuevo', lastName: 'Apellido', sex: 'MALE', birthDate: '1991-02-03', reason: 'Corrección de datos',
      }).expect(200);
      expect(res.body.patient).toMatchObject({ firstName: 'Nuevo', lastName: 'Apellido', sex: 'MALE', birthDate: '1991-02-03' });

      const [log] = await auditOf(id, 'PATIENT_UPDATED');
      expect(log!.summary).toEqual({ changedFields: ['firstName', 'lastName', 'sex', 'birthDate'], reason: 'Corrección de datos' });
      expect(JSON.stringify(log)).not.toMatch(/Nuevo|Apellido|1991|Original/);
      expect((await ctx.db.patient.findUniqueOrThrow({ where: { id } })).updatedById).toBe(w.reception.user.id);
    });

    it('sin cambios reales no genera auditoría; permite borrar el segundo apellido con null', async () => {
      const w = await world();
      const { id } = await createPatient(ctx, w.reception.token, { firstName: 'Igual', lastName: 'Igual', secondLastName: 'Segundo' });
      await ctx.http().patch(`/v1/patients/${id}`).set(bearer(w.reception.token)).send({ firstName: 'Igual' }).expect(200);
      expect(await auditOf(id, 'PATIENT_UPDATED')).toHaveLength(0);
      const res = await ctx.http().patch(`/v1/patients/${id}`).set(bearer(w.reception.token)).send({ secondLastName: null }).expect(200);
      expect(res.body.patient.secondLastName).toBeNull();
    });

    it('el id y la clínica son inmutables también vía API', async () => {
      const w = await world();
      const { id } = await createPatient(ctx, w.reception.token);
      for (const body of [{ id: '8e5f2c5a-7d3e-4f52-9d7c-3b7a1e9d6c11' }, { clinicId: w.b.id }, { status: 'INACTIVE' }]) {
        await ctx.http().patch(`/v1/patients/${id}`).set(bearer(w.reception.token)).send(body).expect(400);
      }
      expect((await ctx.db.patient.findUniqueOrThrow({ where: { id } })).clinicId).toBe(w.a.id);
    });

    it('baja y alta lógicas con motivo; un paciente inactivo no se edita y no se elimina', async () => {
      const w = await world();
      const { id } = await createPatient(ctx, w.reception.token, { lastName: uniq('Baja') });
      await ctx.http().post(`/v1/patients/${id}/deactivate`).set(bearer(w.reception.token)).send({}).expect(400);
      await ctx.http().post(`/v1/patients/${id}/deactivate`).set(bearer(w.reception.token)).send({ reason: 'Fallecimiento informado' }).expect(200);
      await ctx.http().post(`/v1/patients/${id}/deactivate`).set(bearer(w.reception.token)).send({ reason: 'otra vez' }).expect(409);

      await ctx.http().patch(`/v1/patients/${id}`).set(bearer(w.reception.token)).send({ firstName: 'X' }).expect(409);
      await ctx.http().post(`/v1/patients/${id}/contacts`).set(bearer(w.reception.token)).send({ type: 'MOBILE', value: mobile() }).expect(409);
      const lastName = (await ctx.db.patient.findUniqueOrThrow({ where: { id } })).lastName;
      expect((await ctx.http().get(`/v1/patients?name=${lastName}`).set(bearer(w.admin.token)).expect(200)).body).toEqual([]);
      expect((await ctx.http().get(`/v1/patients?name=${lastName}&status=INACTIVE`).set(bearer(w.admin.token)).expect(200)).body).toHaveLength(1);

      await ctx.http().post(`/v1/patients/${id}/reactivate`).set(bearer(w.reception.token)).send({ reason: 'Error de registro' }).expect(200);
      expect((await auditOf(id)).map((l) => l.action)).toEqual(expect.arrayContaining(['PATIENT_DEACTIVATED', 'PATIENT_REACTIVATED']));
      expect(await ctx.db.patient.count({ where: { id } })).toBe(1);
    });
  });

  describe('identificadores', () => {
    it('agrega CE a un paciente con DNI; el DNI se reemplaza solo con motivo y queda historial', async () => {
      const w = await world();
      const oldDni = dni();
      const newDni = dni();
      const { id } = await createPatient(ctx, w.reception.token, { identifier: { type: 'DNI', number: oldDni } });
      const put = (body: object) => ctx.http().put(`/v1/patients/${id}/identifiers`).set(bearer(w.reception.token)).send(body);

      const ce = await put({ type: 'CE', number: 'ce1234567' }).expect(200);
      expect(ce.body.identifiers).toEqual([{ type: 'DNI', number: oldDni }, { type: 'CE', number: 'CE1234567' }]);

      await put({ type: 'DNI', number: newDni }).expect(400); // falta el motivo
      const res = await put({ type: 'DNI', number: newDni, reason: 'Se registró un DNI incorrecto' }).expect(200);
      expect(res.body.changed).toBe(true);
      expect(res.body.identifiers.find((i: { type: string }) => i.type === 'DNI').number).toBe(newDni);

      const history = await ctx.db.patientIdentifier.findMany({ where: { patientId: id, type: 'DNI' }, orderBy: { createdAt: 'asc' } });
      expect(history.map((h) => [h.number, h.status, h.changeReason])).toEqual([
        [oldDni, 'SUPERSEDED', 'Se registró un DNI incorrecto'],
        [newDni, 'ACTIVE', 'Se registró un DNI incorrecto'],
      ]);

      // auditoría con motivo y SOLO valores enmascarados
      const logs = await auditOf(id, 'PATIENT_IDENTIFIER_CHANGED');
      const replaced = logs.find((l) => (l.summary as { operation: string }).operation === 'REPLACED')!;
      expect(replaced.summary).toMatchObject({ type: 'DNI', reason: 'Se registró un DNI incorrecto', previous: `*****${oldDni.slice(-3)}`, new: `*****${newDni.slice(-3)}` });
      expect(JSON.stringify(logs)).not.toContain(oldDni);
      expect(JSON.stringify(logs)).not.toContain(newDni);
    });

    it('rechaza un identificador que ya usa otro paciente de la clínica; repetir el propio es un no-op', async () => {
      const w = await world();
      const taken = dni();
      await createPatient(ctx, w.reception.token, { identifier: { type: 'DNI', number: taken } });
      const mine = dni();
      const { id } = await createPatient(ctx, w.reception.token, { identifier: { type: 'DNI', number: mine } });
      const put = (body: object) => ctx.http().put(`/v1/patients/${id}/identifiers`).set(bearer(w.reception.token)).send(body);
      const conflict = await put({ type: 'DNI', number: taken, reason: 'Corrección' }).expect(409);
      expect(conflict.body.code).toBe('IDENTIFIER_CONFLICT');
      const same = await put({ type: 'DNI', number: mine }).expect(200);
      expect(same.body.changed).toBe(false);
      expect(await auditOf(id, 'PATIENT_IDENTIFIER_CHANGED')).toHaveLength(0);
    });

    it('un DNI reemplazado queda libre para otro paciente', async () => {
      const w = await world();
      const first = dni();
      const { id } = await createPatient(ctx, w.reception.token, { identifier: { type: 'DNI', number: first } });
      await ctx.http().put(`/v1/patients/${id}/identifiers`).set(bearer(w.reception.token)).send({ type: 'DNI', number: dni(), reason: 'Error de digitación' }).expect(200);
      await ctx.http().post('/v1/patients').set(bearer(w.reception.token)).send({ firstName: 'Otro', lastName: 'Paciente', identifier: { type: 'DNI', number: first } }).expect(201);
    });
  });

  describe('contactos', () => {
    it('agrega contactos, no admite dos principales del mismo tipo ni repetidos', async () => {
      const w = await world();
      const { id } = await createPatient(ctx, w.reception.token, { contacts: [{ type: 'MOBILE', value: '987654321' }] });
      const add = (body: object) => ctx.http().post(`/v1/patients/${id}/contacts`).set(bearer(w.reception.token)).send(body);

      const second = await add({ type: 'MOBILE', value: '912345678', label: 'madre' }).expect(201);
      expect(second.body.contact).toMatchObject({ type: 'MOBILE', value: '912345678', isPrimary: false, label: 'madre' });
      await add({ type: 'MOBILE', value: '+51 912 345 678' }).expect(409);
      await add({ type: 'MOBILE', value: '955555555', isPrimary: true }).expect(409);
      await add({ type: 'EMAIL', value: 'x@y.pe' }).expect(201);
    });

    it('cambiar celular o correo exige motivo, conserva historial y audita enmascarado', async () => {
      const w = await world();
      const oldPhone = mobile();
      const newPhone = mobile();
      const { id, res } = await createPatient(ctx, w.reception.token, { contacts: [{ type: 'MOBILE', value: oldPhone }, { type: 'EMAIL', value: 'viejo@correo.pe' }] });
      const contactId = res.body.patient.contacts.find((c: { type: string }) => c.type === 'MOBILE').id as string;
      const emailId = res.body.patient.contacts.find((c: { type: string }) => c.type === 'EMAIL').id as string;
      const patch = (cid: string, body: object) => ctx.http().patch(`/v1/patients/${id}/contacts/${cid}`).set(bearer(w.reception.token)).send(body);

      await patch(contactId, { value: newPhone }).expect(400);
      const changed = await patch(contactId, { value: newPhone, reason: 'La paciente cambió de número' }).expect(200);
      expect(changed.body.contact).toMatchObject({ value: newPhone, isPrimary: true });
      expect(changed.body.contact.id).not.toBe(contactId);

      await patch(emailId, { value: 'nuevo@correo.pe', reason: 'Correo actualizado' }).expect(200);

      const history = await ctx.db.patientContact.findMany({ where: { patientId: id, type: 'MOBILE' }, orderBy: { createdAt: 'asc' } });
      expect(history.map((h) => [h.value, h.status])).toEqual([[oldPhone, 'SUPERSEDED'], [newPhone, 'ACTIVE']]);
      expect(history[0]!.changeReason).toBe('La paciente cambió de número');

      const logs = await auditOf(id, 'PATIENT_CONTACT_CHANGED');
      expect(logs).toHaveLength(2);
      expect(logs[0]!.summary).toMatchObject({ type: 'MOBILE', reason: 'La paciente cambió de número', previous: `******${oldPhone.slice(-3)}` });
      const serialized = JSON.stringify(logs);
      for (const secret of [oldPhone, newPhone, 'viejo@correo.pe', 'nuevo@correo.pe']) expect(serialized).not.toContain(secret);
    });

    it('al cambiar a un celular de otro paciente devuelve la advertencia de posible duplicado', async () => {
      const w = await world();
      const shared = mobile();
      const { id: other } = await createPatient(ctx, w.reception.token, { contacts: [{ type: 'MOBILE', value: shared }] });
      const { id, res } = await createPatient(ctx, w.reception.token, { contacts: [{ type: 'MOBILE', value: mobile() }] });
      const cid = res.body.patient.contacts[0].id as string;
      const out = await ctx.http().patch(`/v1/patients/${id}/contacts/${cid}`).set(bearer(w.reception.token)).send({ value: shared, reason: 'Comparten número familiar' }).expect(200);
      expect(out.body.duplicateWarnings).toEqual([expect.objectContaining({ patientId: other, reasons: ['MOBILE'] })]);
    });

    it('dar de baja un contacto exige motivo para celular/correo y conserva el registro', async () => {
      const w = await world();
      const { id, res } = await createPatient(ctx, w.reception.token, {
        contacts: [{ type: 'MOBILE', value: mobile() }, { type: 'ADDRESS', value: 'Jr. Cusco 45' }],
      });
      const [mob, addr] = [
        res.body.patient.contacts.find((c: { type: string }) => c.type === 'MOBILE').id,
        res.body.patient.contacts.find((c: { type: string }) => c.type === 'ADDRESS').id,
      ] as string[];
      const retire = (cid: string, body: object) => ctx.http().post(`/v1/patients/${id}/contacts/${cid}/retire`).set(bearer(w.reception.token)).send(body);
      await retire(mob!, {}).expect(400);
      await retire(mob!, { reason: 'Número dado de baja' }).expect(200);
      await retire(addr!, {}).expect(200); // la dirección no exige motivo
      await retire(mob!, { reason: 'otra vez' }).expect(404); // ya no está vigente
      expect(await ctx.db.patientContact.count({ where: { patientId: id } })).toBe(2); // nada se borra
      const get = await ctx.http().get(`/v1/patients/${id}`).set(bearer(w.admin.token)).expect(200);
      expect(get.body.contacts).toEqual([]);
    });
  });

  describe('aislamiento estricto entre clínicas', () => {
    it('la clínica B no puede leer ni tocar un paciente de la A (404 uniforme)', async () => {
      const w = await world();
      const { id } = await createPatient(ctx, w.reception.token, { contacts: [{ type: 'MOBILE', value: mobile() }] });
      const contact = await ctx.db.patientContact.findFirstOrThrow({ where: { patientId: id } });
      const t = bearer(w.adminB.token);
      const http = ctx.http();
      const attempts = [
        http.get(`/v1/patients/${id}`).set(t),
        http.patch(`/v1/patients/${id}`).set(t).send({ firstName: 'Hack' }),
        http.post(`/v1/patients/${id}/deactivate`).set(t).send({ reason: 'intento' }),
        http.put(`/v1/patients/${id}/identifiers`).set(t).send({ type: 'DNI', number: dni() }),
        http.post(`/v1/patients/${id}/contacts`).set(t).send({ type: 'MOBILE', value: mobile() }),
        http.patch(`/v1/patients/${id}/contacts/${contact.id}`).set(t).send({ value: mobile(), reason: 'intento' }),
        http.post(`/v1/patients/${id}/contacts/${contact.id}/retire`).set(t).send({ reason: 'intento' }),
        http.get(`/v1/patients/${id}/duplicates`).set(t),
        http.get(`/v1/patients/${id}/guardians`).set(t),
        http.get(`/v1/patients/${id}/consents`).set(t),
        http.get(`/v1/patients/${id}/attachments`).set(t),
      ];
      for (const res of await Promise.all(attempts)) expect(res.status).toBe(404);
      const unchanged = await ctx.db.patient.findUniqueOrThrow({ where: { id } });
      expect(unchanged.firstName).toBe('Ana');
      expect(unchanged.status).toBe('ACTIVE');
    });

    it('un paciente inexistente responde igual que uno ajeno', async () => {
      const w = await world();
      const ghost = await ctx.http().get('/v1/patients/8e5f2c5a-7d3e-4f52-9d7c-3b7a1e9d6c11').set(bearer(w.admin.token)).expect(404);
      const { id } = await createPatient(ctx, w.reception.token);
      const foreign = await ctx.http().get(`/v1/patients/${id}`).set(bearer(w.adminB.token)).expect(404);
      expect({ ...foreign.body, requestId: 0, timestamp: 0, path: 0 }).toEqual({ ...ghost.body, requestId: 0, timestamp: 0, path: 0 });
    });

    it('un usuario con acceso a dos clínicas solo ve la del contexto activo', async () => {
      const w = await world();
      const { id: inA } = await createPatient(ctx, w.reception.token, { lastName: uniq('Multi') });
      const user = await fx.user();
      await fx.assign(user.id, 'RECEPTIONIST', { clinicId: w.a.id });
      await fx.assign(user.id, 'RECEPTIONIST', { clinicId: w.b.id });
      const { loginInContext } = await import('./helpers/app.js');
      const tokenB = await loginInContext(ctx, user.email, { clinicId: w.b.id });
      await ctx.http().get(`/v1/patients/${inA}`).set(bearer(tokenB)).expect(404);
      const tokenA = await loginInContext(ctx, user.email, { clinicId: w.a.id });
      await ctx.http().get(`/v1/patients/${inA}`).set(bearer(tokenA)).expect(200);
    });
  });

  describe('permisos por rol', () => {
    it('administración y recepción gestionan; odontólogo y asistente solo leen; caja solo lectura mínima', async () => {
      const w = await world();
      const { id } = await createPatient(ctx, w.admin.token, { lastName: uniq('Matriz') });
      const body = { firstName: 'N', lastName: 'M' };
      const expectations: [Actor, Record<string, number>][] = [
        [w.admin, { create: 201, read: 200, update: 200, report: 200, dups: 200 }],
        [w.reception, { create: 201, read: 200, update: 200, report: 200, dups: 200 }],
        [w.dentist, { create: 403, read: 200, update: 403, report: 200, dups: 200 }],
        [w.assistant, { create: 403, read: 200, update: 403, report: 200, dups: 200 }],
        [w.cashier, { create: 403, read: 200, update: 403, report: 403, dups: 403 }],
      ];
      for (const [actor, exp] of expectations) {
        const t = bearer(actor.token);
        expect((await ctx.http().post('/v1/patients').set(t).send(body)).status).toBe(exp.create);
        expect((await ctx.http().get(`/v1/patients/${id}`).set(t)).status).toBe(exp.read);
        expect((await ctx.http().patch(`/v1/patients/${id}`).set(t).send({ sex: 'MALE' })).status).toBe(exp.update);
        expect((await ctx.http().get('/v1/patients/duplicate-report').set(t)).status).toBe(exp.report);
        expect((await ctx.http().get(`/v1/patients/${id}/duplicates`).set(t)).status).toBe(exp.dups);
        expect((await ctx.http().get('/v1/patients').set(t)).status).toBe(200);
      }
    });

    it('sin contexto activo no se accede a ningún dato de pacientes', async () => {
      const w = await world();
      const { login } = await import('./helpers/app.js');
      const token = await login(ctx, w.admin.user.email);
      await ctx.http().get('/v1/patients').set(bearer(token)).expect(403);
      await ctx.http().post('/v1/patients').set(bearer(token)).send({ firstName: 'A', lastName: 'B' }).expect(403);
    });

    it('el administrador de plataforma no tiene acceso a datos de pacientes', async () => {
      const w = await world();
      const { id } = await createPatient(ctx, w.reception.token);
      const { loginInContext } = await import('./helpers/app.js');
      const { user } = await fx.userWithRole('PLATFORM_ADMIN');
      const token = await loginInContext(ctx, user.email);
      for (const [method, path] of [
        ['get', '/v1/patients'],
        ['get', `/v1/patients/${id}`],
        ['get', '/v1/patients/duplicate-report'],
        ['get', `/v1/patients/${id}/consents`],
        ['get', `/v1/patients/${id}/attachments`],
        ['get', `/v1/patients/${id}/guardians`],
      ] as const) {
        expect((await ctx.http()[method](path).set(bearer(token))).status).toBe(403);
      }
      await ctx.http().post('/v1/patients').set(bearer(token)).send({ firstName: 'A', lastName: 'B' }).expect(403);
    });

    it('rutas sin JWT: 401', async () => {
      await ctx.http().get('/v1/patients').expect(401);
      await ctx.http().post('/v1/patients').send({}).expect(401);
      await ctx.http().get('/v1/patients/8e5f2c5a-7d3e-4f52-9d7c-3b7a1e9d6c11').expect(401);
    });

    it('rechaza ids con formato inválido', async () => {
      const w = await world();
      await ctx.http().get('/v1/patients/no-es-uuid').set(bearer(w.admin.token)).expect(400);
    });
  });

  describe('auditoría de lecturas y modificaciones', () => {
    it('registra quién leyó, buscó y modificó, sin copiar datos personales', async () => {
      const w = await world();
      const number = dni();
      const phone = mobile();
      const last = uniq('Auditado');
      const { id } = await createPatient(ctx, w.reception.token, {
        firstName: 'Paola', lastName: last, identifier: { type: 'DNI', number }, contacts: [{ type: 'MOBILE', value: phone }],
      });
      await ctx.http().get(`/v1/patients/${id}`).set(bearer(w.dentist.token)).expect(200);
      await ctx.http().get(`/v1/patients/${id}`).set(bearer(w.cashier.token)).expect(200);
      await ctx.http().get(`/v1/patients?identifier=${number}&name=${last}`).set(bearer(w.reception.token)).expect(200);
      await ctx.http().get(`/v1/patients/${id}/duplicates`).set(bearer(w.admin.token)).expect(200);

      const views = await auditOf(id, 'PATIENT_VIEWED');
      const byString = (x: string | null, y: string | null) => String(x).localeCompare(String(y));
      expect(views.map((v) => v.userId).sort(byString)).toEqual([w.dentist.user.id, w.cashier.user.id].sort(byString));
      expect(views.find((v) => v.userId === w.dentist.user.id)!.summary).toEqual({ sections: ['demographics', 'contacts', 'guardians'] });
      expect(views.find((v) => v.userId === w.cashier.user.id)!.summary).toEqual({ sections: ['basic'] });
      expect(views.every((v) => v.clinicId === w.a.id && v.ip)).toBe(true);

      const searches = await ctx.db.auditLog.findMany({ where: { action: 'PATIENT_SEARCHED', userId: w.reception.user.id } });
      expect(searches.at(-1)!.summary).toEqual({ filters: ['identifier', 'name'], resultCount: 1, offset: 0 });
      expect(await auditOf(id, 'PATIENT_DUPLICATES_VIEWED')).toHaveLength(1);

      // Nada de lo que se buscó o creó aparece en la auditoría inmutable
      const all = JSON.stringify(await ctx.db.auditLog.findMany({ where: { clinicId: w.a.id } }));
      for (const secret of [number, phone, last, 'Paola']) expect(all).not.toContain(secret);
    });

    it('una lectura denegada o fallida no genera falsos accesos', async () => {
      const w = await world();
      const { id } = await createPatient(ctx, w.reception.token);
      const before = (await auditOf(id, 'PATIENT_VIEWED')).length;
      await ctx.http().get(`/v1/patients/${id}`).set(bearer(w.adminB.token)).expect(404);
      expect((await auditOf(id, 'PATIENT_VIEWED')).length).toBe(before);
    });

    it('GET /v1/audit-logs?patientId= permite ver la trazabilidad del paciente solo a su clínica', async () => {
      const w = await world();
      const { id } = await createPatient(ctx, w.reception.token);
      await ctx.http().get(`/v1/patients/${id}`).set(bearer(w.dentist.token)).expect(200);
      const res = await ctx.http().get(`/v1/audit-logs?patientId=${id}`).set(bearer(w.admin.token)).expect(200);
      expect(res.body.map((l: { action: string }) => l.action)).toEqual(expect.arrayContaining(['PATIENT_CREATED', 'PATIENT_VIEWED']));
      expect(res.body.every((l: { clinicId: string; patientId: string }) => l.clinicId === w.a.id && l.patientId === id)).toBe(true);
      const other = await ctx.http().get(`/v1/audit-logs?patientId=${id}`).set(bearer(w.adminB.token)).expect(200);
      expect(other.body).toEqual([]);
      await ctx.http().get(`/v1/audit-logs?patientId=${id}`).set(bearer(w.reception.token)).expect(403);
    });
  });
});
