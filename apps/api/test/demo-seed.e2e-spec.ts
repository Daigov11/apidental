import { seedDemoAgenda } from '../prisma/demo-agenda.js';
import { seedDemoCases } from '../prisma/demo-cases.js';
import { seedDemoClinicHistory } from '../prisma/demo-clinic-history.js';
import { seedDemoExtra } from '../prisma/demo-extra.js';
import {
  DEMO_CATALOG,
  DEMO_STAFF,
  seedDemoClinical,
} from '../prisma/demo-data.js';
import {
  actorIn,
  bearer,
  createPatient,
  createTestContext,
  Fixtures,
  login,
  reauthProofFor,
  type TestContext,
} from './helpers/app.js';

const DEMO_PASSWORD = 'Clave-Demo-Ficticia-2026';
const FICTITIOUS = /demo|ficticio|demostración|ejemplo/i;

describe('Datos de demostración de Clínica Demo (ficticios) y flujo completo', () => {
  let ctx: TestContext;
  let fx: Fixtures;
  beforeAll(async () => {
    ctx = await createTestContext();
    fx = new Fixtures(ctx.db);
  });
  afterAll(() => ctx.close());

  async function demoWorld() {
    const clinic = await fx.clinic('Clínica Demo (prueba)');
    const branch = await fx.branch(clinic.id, 'Sede Demo');
    const admin = await fx.user();
    await fx.assign(admin.id, 'CLINIC_ADMIN', { clinicId: clinic.id });
    const reception = await actorIn(ctx, fx, 'RECEPTIONIST', {
      clinicId: clinic.id,
    });
    const mk = async (
      dni: string,
      first: string,
      last: string,
      birth: string,
    ) =>
      (
        await createPatient(ctx, reception.token, {
          firstName: first,
          lastName: last,
          birthDate: birth,
          identifier: { type: 'DNI', number: dni },
        })
      ).id;
    const lucia = await mk('90000001', 'Lucía', 'Demo', '1988-04-12');
    const mateo = await mk('90000002', 'Mateo', 'Demo', '2017-09-30');
    const jorge = await mk('90000004', 'Jorge', 'Demo', '1975-01-20');
    for (const id of [lucia, mateo]) {
      await ctx.db.patientConsent.create({
        data: {
          clinicId: clinic.id,
          patientId: id,
          type: 'CLINICAL',
          activeKey: `${id}|CLINICAL`,
          grantedBy: 'PATIENT',
          documentTitle: 'Consentimiento informado (demo)',
          documentVersion: 'demo-1.0',
          grantedAt: new Date(),
          createdById: admin.id,
        },
      });
    }
    const first = await seedDemoClinical(ctx.db, {
      clinicId: clinic.id,
      branchId: branch.id,
      adminUserId: admin.id,
      password: DEMO_PASSWORD,
    });
    return { clinic, branch, admin, reception, lucia, mateo, jorge, first };
  }

  async function demoLogin(email: string, clinicId: string, branchId?: string) {
    const token = await login(ctx, email, DEMO_PASSWORD);
    const res = await ctx
      .http()
      .post('/v1/auth/select-context')
      .set(bearer(token))
      .send({ clinicId, ...(branchId ? { branchId } : {}) })
      .expect(200);
    return res.body.accessToken as string;
  }
  const visitOf = (patientId: string) =>
    ctx.db.clinicalVisit.findFirstOrThrow({ where: { patientId } });

  it('crea el equipo, el catálogo y tres pacientes con atención; es idempotente', async () => {
    const w = await demoWorld();
    expect(Object.keys(w.first.users).sort()).toEqual([
      'assistant',
      'cashier',
      'dentist',
      'director',
      'reception',
    ]);
    expect(Object.keys(w.first.patients).sort()).toEqual([
      'jorge',
      'lucia',
      'mateo',
    ]);
    const counts = async () => ({
      users: await ctx.db.user.count({
        where: { email: { endsWith: '@apidental.test' } },
      }),
      visits: await ctx.db.clinicalVisit.count({
        where: { clinicId: w.clinic.id },
      }),
      notes: await ctx.db.clinicalNote.count({
        where: { clinicId: w.clinic.id },
      }),
      defs: await ctx.db.procedureDefinition.count({
        where: { clinicId: w.clinic.id },
      }),
    });
    const before = await counts();
    await seedDemoClinical(ctx.db, {
      clinicId: w.clinic.id,
      branchId: w.branch.id,
      adminUserId: w.admin.id,
      password: DEMO_PASSWORD,
    });
    expect(await counts()).toEqual(before);
    expect(before.visits).toBe(3);
    expect(before.defs).toBe(DEMO_CATALOG.length);
  });

  it('todo dato sembrado es claramente ficticio: correos reservados @apidental.test, nombres "Demo" y textos marcados', async () => {
    const w = await demoWorld();
    for (const s of DEMO_STAFF) {
      expect(s.email.endsWith('@apidental.test')).toBe(true);
      expect(s.lastName).toMatch(/Demo/);
    }
    const c = w.clinic.id;
    const texts: string[] = [
      ...(
        await ctx.db.clinicalDiagnosis.findMany({ where: { clinicId: c } })
      ).map((x) => x.description),
      ...(
        await ctx.db.clinicalNote.findMany({ where: { clinicId: c } })
      ).flatMap((x) =>
        [x.body, x.followUp ?? '', x.changeReason ?? ''].filter(Boolean),
      ),
      ...(
        await ctx.db.clinicalProcedure.findMany({ where: { clinicId: c } })
      ).flatMap((x) => [x.notes ?? '', x.definitionName].filter(Boolean)),
      ...(
        await ctx.db.clinicalHistoryEntry.findMany({ where: { clinicId: c } })
      ).flatMap((x) =>
        [x.label, x.condition ?? '', x.observations ?? ''].filter(Boolean),
      ),
      ...(await ctx.db.clinicalAlert.findMany({ where: { clinicId: c } })).map(
        (x) => x.text,
      ),
      ...(
        await ctx.db.procedureDefinition.findMany({ where: { clinicId: c } })
      ).flatMap((x) => [x.name, x.description ?? '']),
      ...(await ctx.db.clinicalVisit.findMany({ where: { clinicId: c } })).map(
        (x) => x.reason ?? '',
      ),
    ].filter(Boolean);
    expect(texts.length).toBeGreaterThan(15);
    for (const t of texts) expect(t, t).toMatch(FICTITIOUS);
    // sin teléfonos, correos ni documentos reales en los textos clínicos
    for (const t of texts) expect(t).not.toMatch(/@|\b\d{8,}\b|https?:/);
    const staff = await ctx.db.user.findMany({
      where: { id: { in: Object.values(w.first.users) } },
    });
    for (const u of staff) {
      expect(u.email.endsWith('@apidental.test')).toBe(true);
      expect(`${u.firstName} ${u.lastName}`).toMatch(/Demo/);
    }
  });

  it('Lucía: alerta/alergia → visita cerrada → diagnóstico → procedimiento realizado → evolución CORREGIDA (la ficha completa, en una lectura)', async () => {
    const w = await demoWorld();
    const dentist = await demoLogin(
      DEMO_STAFF[0].email,
      w.clinic.id,
      w.branch.id,
    );
    const v = await visitOf(w.lucia);
    const sheet = (
      await ctx
        .http()
        .get(`/v1/patients/${w.lucia}/clinical/visits/${v.id}/sheet`)
        .set(bearer(dentist))
        .expect(200)
    ).body;
    expect(Object.keys(sheet)[0]).toBe('alerts');
    expect(sheet.alerts.items.map((a: { label: string }) => a.label)).toEqual(
      expect.arrayContaining([
        'Alergia a un material ficticio (demostración)',
        'Aviso de demostración (dato ficticio)',
      ]),
    );
    expect(sheet.allergyAssessment.label).toBe('Tiene alergias registradas');
    expect(sheet.visit).toMatchObject({ statusLabel: 'Cerrada', number: 1 });
    expect(sheet.diagnoses).toHaveLength(1);
    expect(sheet.procedures[0]).toMatchObject({
      status: 'CLOSED',
      statusLabel: 'Realizado',
      requiresConsent: true,
      closeBlockedByConsent: false,
    });
    expect(sheet.evolution).toMatchObject({
      state: 'CORRECTED',
      stateLabel: 'Corregida',
      version: 3,
    });
    expect(sheet.evolution.lastChange.reason).toBe(
      'Se agrega una aclaración de ejemplo',
    );
    expect(sheet.evolution.closure).toMatchObject({ isSignature: false });
    expect(sheet.actions.canCorrectEvolution).toBe(true);
    const versions = (
      await ctx
        .http()
        .get(
          `/v1/patients/${w.lucia}/clinical/visits/${v.id}/evolution/versions`,
        )
        .set(bearer(dentist))
        .expect(200)
    ).body.versions;
    expect(versions.map((x: { state: string }) => x.state)).toEqual([
      'CORRECTED',
      'CLOSED',
      'DRAFT',
    ]);
  });

  it('odontogramas de ejemplo: Lucía guardado y corregido, Mateo en borrador, Jorge guardado; se exporta a PDF con el aviso de formato por validar', async () => {
    const w = await demoWorld();
    const dentist = await demoLogin(
      DEMO_STAFF[0].email,
      w.clinic.id,
      w.branch.id,
    );
    const luciaState = (
      await ctx
        .http()
        .get(`/v1/patients/${w.lucia}/clinical/odontogram`)
        .set(bearer(dentist))
        .expect(200)
    ).body;
    expect(luciaState.official).toMatchObject({
      version: 4,
      state: 'CORRECTED',
      stateLabel: 'Corregida',
      kind: 'RECTIFIED',
      dentition: 'PERMANENT',
    });
    expect(luciaState.official.lastChange.reason).toBe(
      'Se agregan dos piezas aclaradas (ejemplo)',
    );
    expect(Object.keys(luciaState.official.data.teeth).sort()).toEqual([
      '14',
      '16',
      '18',
      '21',
      '24',
      '26',
      '36',
      '46',
      '47',
    ]);
    expect(luciaState.official.data.teeth['36']).toEqual({ status: 'ABSENT' });
    expect(luciaState.official.closure).toMatchObject({ isSignature: false });
    const mateoState = (
      await ctx
        .http()
        .get(`/v1/patients/${w.mateo}/clinical/odontogram`)
        .set(bearer(dentist))
        .expect(200)
    ).body;
    expect(mateoState.official).toBeNull();
    expect(mateoState.draft).toMatchObject({
      state: 'DRAFT',
      stateLabel: 'Borrador',
      dentition: 'MIXED',
      contentHidden: false,
    });
    const jorgeState = (
      await ctx
        .http()
        .get(`/v1/patients/${w.jorge}/clinical/odontogram`)
        .set(bearer(dentist))
        .expect(200)
    ).body;
    expect(jorgeState.official).toMatchObject({
      version: 2,
      stateLabel: 'Guardada',
    });

    const pdf = await ctx
      .http()
      .get(`/v1/patients/${w.lucia}/clinical/odontogram/export`)
      .set(bearer(dentist))
      .buffer(true)
      .parse((res, cb) => {
        const c: Buffer[] = [];
        res.on('data', (d: Buffer) => c.push(d));
        res.on('end', () => cb(null, Buffer.concat(c)));
      })
      .expect(200);
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    const svg = await ctx
      .http()
      .get(`/v1/patients/${w.lucia}/clinical/odontogram/export?format=svg`)
      .set(bearer(dentist))
      .buffer(true)
      .parse((res, cb) => {
        const c: Buffer[] = [];
        res.on('data', (d: Buffer) => c.push(d));
        res.on('end', () => cb(null, Buffer.concat(c)));
      })
      .expect(200);
    expect((svg.body as Buffer).toString('utf8')).toContain('id="tooth-47"');
    // la asistente no ve el detalle; el Director solo con autorización
    const assistant = await demoLogin(
      DEMO_STAFF[1].email,
      w.clinic.id,
      w.branch.id,
    );
    expect(
      (
        await ctx
          .http()
          .get(`/v1/patients/${w.lucia}/clinical/odontogram`)
          .set(bearer(assistant))
          .expect(403)
      ).body.code,
    ).toBe('CLINICAL_LIMITED_VIEW');
    const director = await demoLogin(DEMO_STAFF[3].email, w.clinic.id);
    await ctx
      .http()
      .get(`/v1/patients/${w.lucia}/clinical/odontogram`)
      .set(bearer(director))
      .expect(403);
  });

  it('Mateo: visita abierta con la evolución en BORRADOR (se puede seguir editando y cerrar con contraseña)', async () => {
    const w = await demoWorld();
    const dentist = await demoLogin(
      DEMO_STAFF[0].email,
      w.clinic.id,
      w.branch.id,
    );
    const v = await visitOf(w.mateo);
    const sheet = (
      await ctx
        .http()
        .get(`/v1/patients/${w.mateo}/clinical/visits/${v.id}/sheet`)
        .set(bearer(dentist))
        .expect(200)
    ).body;
    expect(sheet.visit.statusLabel).toBe('Abierta');
    expect(sheet.evolution).toMatchObject({
      state: 'DRAFT',
      stateLabel: 'Borrador',
    });
    expect(sheet.actions).toMatchObject({
      canWriteEvolution: true,
      canCloseEvolution: true,
    });
    const saved = await ctx
      .http()
      .put(`/v1/patients/${w.mateo}/clinical/visits/${v.id}/evolution`)
      .set(bearer(dentist))
      .send({
        body: 'Borrador de demostración completado (dato ficticio).',
        expectedEtag: sheet.evolution.etag,
      })
      .expect(200);
    // el procedimiento "Control" no exige consentimiento y se cierra; luego se cierra la evolución con la contraseña demo
    const proc = sheet.procedures[0];
    await ctx
      .http()
      .post(`/v1/patients/${w.mateo}/clinical/procedures/${proc.id}/close`)
      .set(bearer(dentist))
      .send({ expectedVersion: proc.version })
      .expect(200);
    const closed = await ctx
      .http()
      .post(`/v1/patients/${w.mateo}/clinical/visits/${v.id}/evolution/close`)
      .set(bearer(dentist))
      .send({
        expectedEtag: saved.body.evolution.etag,
        password: DEMO_PASSWORD,
      })
      .expect(200);
    expect(closed.body.evolution).toMatchObject({
      state: 'CLOSED',
      stateLabel: 'Cerrada',
    });
    await ctx
      .http()
      .post(`/v1/patients/${w.mateo}/clinical/visits/${v.id}/close`)
      .set(bearer(dentist))
      .send({ expectedVersion: v.version })
      .expect(200);
  });

  it('Jorge: sin consentimiento clínico, el procedimiento obligatorio avisa y no se cierra; diagnosticar y evolucionar sí', async () => {
    const w = await demoWorld();
    const dentist = await demoLogin(
      DEMO_STAFF[0].email,
      w.clinic.id,
      w.branch.id,
    );
    const v = await visitOf(w.jorge);
    const sheet = (
      await ctx
        .http()
        .get(`/v1/patients/${w.jorge}/clinical/visits/${v.id}/sheet`)
        .set(bearer(dentist))
        .expect(200)
    ).body;
    expect(sheet.consent).toMatchObject({
      state: 'MISSING',
      label: 'Falta el consentimiento clínico',
    });
    expect(sheet.evolution).toMatchObject({
      state: 'CLOSED',
      stateLabel: 'Cerrada',
    });
    expect(sheet.procedures[0]).toMatchObject({
      statusLabel: 'En curso',
      closeBlockedByConsent: true,
      canClose: false,
    });
    expect(sheet.procedures[0].closeBlockedMessage).toMatch(
      /falta el consentimiento clínico/,
    );
    const blocked = await ctx
      .http()
      .post(
        `/v1/patients/${w.jorge}/clinical/procedures/${sheet.procedures[0].id}/close`,
      )
      .set(bearer(dentist))
      .send({ expectedVersion: 1 })
      .expect(409);
    expect(blocked.body.code).toBe('CLINICAL_CONSENT_REQUIRED');
    expect(sheet.actions.canCloseVisit).toBe(false);
  });

  it('cada perfil ve lo que le corresponde: asistente solo alertas, recepción solo lectura, administración nada clínico, Director solo lectura excepcional', async () => {
    const w = await demoWorld();
    const v = await visitOf(w.lucia);
    const assistant = await demoLogin(
      DEMO_STAFF[1].email,
      w.clinic.id,
      w.branch.id,
    );
    const reception = await demoLogin(DEMO_STAFF[2].email, w.clinic.id);
    const director = await demoLogin(DEMO_STAFF[3].email, w.clinic.id);
    const alerts = (
      await ctx
        .http()
        .get(`/v1/patients/${w.lucia}/clinical/alerts`)
        .set(bearer(assistant))
        .expect(200)
    ).body;
    expect(alerts.alerts.map((a: { label: string }) => a.label)).toEqual(
      expect.arrayContaining(['Alergia a un material ficticio (demostración)']),
    );
    expect(JSON.stringify(alerts)).not.toMatch(
      /Diagnóstico|Evolución|Procedimiento/,
    );
    expect(
      (
        await ctx
          .http()
          .get(`/v1/patients/${w.lucia}/clinical/visits/${v.id}/sheet`)
          .set(bearer(assistant))
          .expect(403)
      ).body.code,
    ).toBe('CLINICAL_LIMITED_VIEW');
    await ctx
      .http()
      .get(`/v1/patients/${w.lucia}/clinical/visits/${v.id}/sheet`)
      .set(bearer(reception))
      .expect(200);
    await ctx
      .http()
      .get(`/v1/patients/${w.lucia}/clinical/visits/${v.id}/sheet`)
      .set(bearer(director))
      .expect(403);
    const proof = await reauthProofFor(
      ctx,
      director,
      'CLINICAL_READ_ALL',
      w.lucia,
      DEMO_PASSWORD,
    );
    await ctx
      .http()
      .post(`/v1/patients/${w.lucia}/clinical-access`)
      .set(bearer(director))
      .send({
        category: 'CONTINUITY_OF_CARE',
        reason: 'Revisión de demostración del flujo',
        reauthToken: proof,
      })
      .expect(201);
    const read = (
      await ctx
        .http()
        .get(`/v1/patients/${w.lucia}/clinical/visits/${v.id}/sheet`)
        .set(bearer(director))
        .expect(200)
    ).body;
    expect(read.access.level).toBe('READ_ALL');
    expect(read.actions.readOnly).toBe(true);
    // la recepción demo puede ver el paciente (datos administrativos) pero no lo clínico
    await ctx
      .http()
      .get(`/v1/patients/${w.lucia}`)
      .set(bearer(reception))
      .expect(200);
  });

  it('agenda demo: consultorios, servicios y citas ficticias; idempotente; la cita de hoy lleva a la atención; recepción solo lee', async () => {
    const w = await demoWorld();
    await createPatient(ctx, w.reception.token, {
      firstName: 'Camila',
      lastName: 'Demo',
      birthDate: '1995-06-18',
      identifier: { type: 'DNI', number: '90000006' },
    });
    const agendaCtx = {
      clinicId: w.clinic.id,
      branchId: w.branch.id,
      dentistId: w.first.users['dentist']!,
      receptionId: w.first.users['reception']!,
      adminUserId: w.admin.id,
    };
    const first = await seedDemoAgenda(ctx.db, agendaCtx);
    expect(first).toEqual({ rooms: 2, services: 4, appointments: 6 });
    const count = () =>
      ctx.db.appointment.count({ where: { clinicId: w.clinic.id } });
    expect(await count()).toBe(6);
    expect((await seedDemoAgenda(ctx.db, agendaCtx)).appointments).toBe(0);
    expect(await count()).toBe(6);
    // todo es ficticio y marcado
    const appts = await ctx.db.appointment.findMany({
      where: { clinicId: w.clinic.id },
    });
    for (const a of appts) expect(a.notes).toMatch(/^Demo:/);
    const names = [
      ...(await ctx.db.room.findMany({ where: { clinicId: w.clinic.id } })),
      ...(await ctx.db.agendaService.findMany({
        where: { clinicId: w.clinic.id },
      })),
    ].map((x) => x.name);
    for (const n of names) expect(n).toMatch(/demo/i);

    const dentist = await demoLogin(
      'odontologa.demo@apidental.test',
      w.clinic.id,
      w.branch.id,
    );
    const camila = await ctx.db.patientIdentifier.findFirstOrThrow({
      where: { clinicId: w.clinic.id, number: '90000006' },
    });
    const today = await ctx.db.appointment.findFirstOrThrow({
      where: { patientId: camila.patientId, status: 'RESERVED' },
    });
    // recepción: ve la cita, no la atiende ni ve lo clínico
    await ctx
      .http()
      .post(`/v1/appointments/${today.id}/start-attention`)
      .set(bearer(w.reception.token))
      .expect(403);
    const started = await ctx
      .http()
      .post(`/v1/appointments/${today.id}/start-attention`)
      .set(bearer(dentist))
      .expect(200);
    expect(started.body.appointment.status).toBe('ATTENDED');
    expect(started.body.visit.number).toBe(1);
    await ctx
      .http()
      .get(
        `/v1/patients/${camila.patientId}/clinical/visits/${started.body.visit.id}/sheet`,
      )
      .set(bearer(dentist))
      .expect(200);
    await ctx
      .http()
      .get(
        `/v1/patients/${camila.patientId}/clinical/visits/${started.body.visit.id}/sheet`,
      )
      .set(bearer(w.reception.token))
      .expect(200);
  });

  it('historias demo: 4 odontólogos más, citas sin choques, visitas enlazadas y odontogramas con varias versiones; idempotente', async () => {
    const w = await demoWorld();
    const c = {
      clinicId: w.clinic.id,
      branchId: w.branch.id,
      dentistId: w.first.users['dentist']!,
      receptionId: w.first.users['reception']!,
      adminUserId: w.admin.id,
    };
    await seedDemoAgenda(ctx.db, c);
    await seedDemoExtra(ctx.db, c);
    await seedDemoCases(ctx.db, c);
    const h = await seedDemoClinicHistory(ctx.db, { ...c, password: DEMO_PASSWORD });
    expect(h['dentists']).toBe(4);
    expect(h['appointments']).toBeGreaterThanOrEqual(90);
    const mine = await ctx.db.appointment.findMany({
      where: { clinicId: w.clinic.id, notes: { startsWith: 'Demo§:' } },
    });
    expect(mine.length).toBe(h['appointments']);
    expect(new Set(mine.map((a) => a.dentistUserId)).size).toBe(5);
    expect(new Set(mine.map((a) => a.roomId)).size).toBeGreaterThanOrEqual(3);
    for (const a of mine) {
      expect(a.startsAt.getTime() % (15 * 60_000)).toBe(0);
      if (a.status === 'ATTENDED') expect(a.visitId).not.toBeNull();
      if (a.status === 'CANCELLED') expect(a.cancelReason).toBeTruthy();
      if (a.status === 'NO_SHOW') expect(a.noShowReason).toBeTruthy();
    }
    expect(await ctx.db.clinicalVisit.count({ where: { clinicId: w.clinic.id, status: 'OPEN', reason: { startsWith: 'DEMO§' } } })).toBe(0);
    const odo = await ctx.db.clinicalOdontogram.groupBy({ by: ['patientId'], where: { clinicId: w.clinic.id, status: 'CLOSED' }, _count: true });
    expect(odo.some((x) => x._count >= 3)).toBe(true);
    const before = await ctx.db.appointment.count({ where: { clinicId: w.clinic.id } });
    const again = await seedDemoClinicHistory(ctx.db, { ...c, password: DEMO_PASSWORD });
    expect(again['appointments']).toBe(0);
    expect(again['visits']).toBe(0);
    expect(await ctx.db.appointment.count({ where: { clinicId: w.clinic.id } })).toBe(before);
  });
});
