import { vi } from 'vitest';
import { AuditService } from '../src/audit/audit.service.js';
import {
  actorIn,
  assignCare,
  bearer,
  createPatient,
  createTestContext,
  Fixtures,
  grantReadAll,
  loginInContext,
  revokeCareReq,
  type TestContext,
  uniq,
} from './helpers/app.js';

const GHOST = '8e5f2c5a-7d3e-4f52-9d7c-3b7a1e9d6c11';
const expectStatus = <T extends { status: number; body: unknown }>(
  res: T,
  status: number,
): T => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res;
};

describe('Parche 3.2.1: evaluación de alergias y motivo del alta', () => {
  let ctx: TestContext;
  let fx: Fixtures;
  beforeAll(async () => {
    ctx = await createTestContext();
    fx = new Fixtures(ctx.db);
  });
  afterAll(() => ctx.close());
  afterEach(() => vi.restoreAllMocks());

  async function world() {
    const clinic = await fx.clinic();
    const admin = await actorIn(ctx, fx, 'CLINIC_ADMIN', {
      clinicId: clinic.id,
    });
    const reception = await actorIn(ctx, fx, 'RECEPTIONIST', {
      clinicId: clinic.id,
    });
    const dentist = await actorIn(ctx, fx, 'DENTIST', { clinicId: clinic.id });
    const assistant = await actorIn(ctx, fx, 'ASSISTANT', {
      clinicId: clinic.id,
    });
    const director = await actorIn(ctx, fx, 'CLINICAL_DIRECTOR', {
      clinicId: clinic.id,
    });
    const { id: patientId } = await createPatient(ctx, reception.token, {
      lastName: uniq('Apellido'),
    });
    const rel = await assignCare(
      ctx,
      reception.token,
      patientId,
      dentist.user.id,
    );
    return {
      clinic,
      admin,
      reception,
      dentist,
      assistant,
      director,
      patientId,
      rel,
    };
  }
  type W = Awaited<ReturnType<typeof world>>;

  const base = (id: string) => `/v1/patients/${id}/clinical`;
  const get = (t: string, id: string, p: string) =>
    ctx
      .http()
      .get(`${base(id)}${p}`)
      .set(bearer(t));
  const post = (t: string, id: string, p: string, b: unknown) =>
    ctx
      .http()
      .post(`${base(id)}${p}`)
      .set(bearer(t))
      .send(b as object);
  const putA = (t: string, id: string, b: unknown) =>
    ctx
      .http()
      .put(`${base(id)}/allergy-assessment`)
      .set(bearer(t))
      .send(b as object);
  const assess = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    status: 'NO_KNOWN_ALLERGIES',
    source: 'PATIENT',
    expectedVersion: 0,
    ...over,
  });
  const allergy = (over: Record<string, unknown> = {}) => ({
    kind: 'ALLERGY',
    label: uniq('Alergeno-'),
    source: 'PATIENT',
    isCritical: false,
    ...over,
  });
  const change = (v: number, over: Record<string, unknown> = {}) => ({
    expectedVersion: v,
    reason: 'Motivo del cambio',
    ...over,
  });
  const current = async (w: W) =>
    (await get(w.dentist.token, w.patientId, '/allergy-assessment').expect(200))
      .body;
  const rows = (patientId: string) =>
    ctx.db.clinicalAllergyAssessment.findMany({
      where: { patientId },
      orderBy: { version: 'asc' },
    });

  describe('estado inicial y declaración', () => {
    it('sin evaluación el estado es NOT_ASKED (versión 0); declarar NO_KNOWN_ALLERGIES no exige motivo en el alta', async () => {
      const w = await world();
      expect(await current(w)).toMatchObject({
        status: 'NOT_ASKED',
        version: 0,
        derived: true,
        activeAllergyCount: 0,
      });
      const body = assess({ observations: uniq('OBS-NO-AUDITAR-') });
      const res = expectStatus(
        await putA(w.dentist.token, w.patientId, body),
        200,
      );
      expect(res.body).toMatchObject({
        status: 'NO_KNOWN_ALLERGIES',
        version: 1,
        source: 'PATIENT',
        observations: body.observations,
        lastChange: {
          kind: 'CREATED',
          reason: null,
          automatic: false,
          byUserId: w.dentist.user.id,
        },
      });
      expect(res.body.assessedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(await current(w)).toMatchObject({
        status: 'NO_KNOWN_ALLERGIES',
        version: 1,
        derived: false,
      });
      // la auditoría no guarda el estado ni las observaciones: solo versión y campos
      const logs = await ctx.db.auditLog.findMany({
        where: {
          patientId: w.patientId,
          action: 'CLINICAL_ALLERGY_ASSESSMENT_SET',
        },
      });
      expect(logs).toHaveLength(1);
      expect(logs[0]!.summary).toMatchObject({
        version: 1,
        automatic: false,
        fields: ['status', 'assessedOn', 'source', 'observations'],
      });
      expect(JSON.stringify(logs)).not.toMatch(/NO_KNOWN|OBS-NO-AUDITAR/);
    });

    it('la fuente es obligatoria; ALLERGIES_RECORDED no se declara; fechas inválidas o futuras se rechazan', async () => {
      const w = await world();
      for (const over of [
        { source: undefined },
        { source: 'RUMOR' },
        { status: 'ALLERGIES_RECORDED' },
        { status: 'TAL_VEZ' },
        { assessedOn: '2999-01-01' },
        { assessedOn: '2024-02-31' },
        { expectedVersion: -1 },
        { expectedVersion: undefined },
        { observations: 'a'.repeat(501) },
        { reason: 'ab' },
      ]) {
        await putA(w.dentist.token, w.patientId, assess(over)).expect(400);
      }
      expect(await rows(w.patientId)).toHaveLength(0);
    });

    it('a partir de la segunda versión el motivo es obligatorio y se exige la versión esperada', async () => {
      const w = await world();
      await putA(w.dentist.token, w.patientId, assess()).expect(200);
      await putA(
        w.dentist.token,
        w.patientId,
        assess({ status: 'NOT_ASKED', expectedVersion: 1 }),
      ).expect(400); // sin motivo
      await putA(
        w.dentist.token,
        w.patientId,
        assess({
          status: 'NOT_ASKED',
          expectedVersion: 0,
          reason: 'Se revierte',
        }),
      ).expect(409); // versión vieja
      const stale = await putA(
        w.dentist.token,
        w.patientId,
        assess({
          status: 'NOT_ASKED',
          expectedVersion: 7,
          reason: 'Se revierte',
        }),
      ).expect(409);
      expect(stale.body).toMatchObject({
        code: 'VERSION_CONFLICT',
        currentVersion: 1,
      });
      await putA(
        w.dentist.token,
        w.patientId,
        assess({ expectedVersion: 1, reason: 'Sin cambios reales' }),
      ).expect(400); // idéntica a la vigente
      const ok = expectStatus(
        await putA(
          w.dentist.token,
          w.patientId,
          assess({
            status: 'NOT_ASKED',
            expectedVersion: 1,
            reason: 'El paciente pidió volver a evaluar',
          }),
        ),
        200,
      );
      expect(ok.body).toMatchObject({
        status: 'NOT_ASKED',
        version: 2,
        lastChange: {
          kind: 'RECTIFIED',
          reason: 'El paciente pidió volver a evaluar',
        },
      });
      // reconfirmar con otra fecha sí es un cambio válido
      await putA(
        w.dentist.token,
        w.patientId,
        assess({
          expectedVersion: 2,
          assessedOn: '2024-05-01',
          reason: 'Se vuelve a consultar al paciente',
        }),
      ).expect(200);
      const versions = (
        await get(
          w.dentist.token,
          w.patientId,
          '/allergy-assessment/versions',
        ).expect(200)
      ).body;
      expect(versions.map((v: { version: number }) => v.version)).toEqual([
        3, 2, 1,
      ]);
    });
  });

  describe('invariante con las alergias activas', () => {
    it('NO_KNOWN_ALLERGIES (y NOT_ASKED) se rechazan si hay una alergia activa', async () => {
      const w = await world();
      await post(w.dentist.token, w.patientId, '/history', allergy()).expect(
        201,
      );
      const res = await putA(
        w.dentist.token,
        w.patientId,
        assess({ expectedVersion: 1, reason: 'Intento inválido' }),
      ).expect(409);
      expect(res.body).toMatchObject({ code: 'ALLERGIES_ACTIVE' });
      await putA(
        w.dentist.token,
        w.patientId,
        assess({
          status: 'NOT_ASKED',
          expectedVersion: 1,
          reason: 'Intento inválido',
        }),
      ).expect(409);
      expect(await current(w)).toMatchObject({
        status: 'ALLERGIES_RECORDED',
        version: 1,
        activeAllergyCount: 1,
      });
    });

    it('registrar una alergia activa pasa a ALLERGIES_RECORDED (versión automática); un antecedente no', async () => {
      const w = await world();
      await putA(w.dentist.token, w.patientId, assess()).expect(200);
      await post(w.dentist.token, w.patientId, '/history', {
        kind: 'BACKGROUND',
        label: uniq('Asma-'),
        source: 'PATIENT',
      }).expect(201);
      expect(await current(w)).toMatchObject({
        status: 'NO_KNOWN_ALLERGIES',
        version: 1,
      });
      await post(w.dentist.token, w.patientId, '/history', allergy()).expect(
        201,
      );
      const cur = await current(w);
      expect(cur).toMatchObject({
        status: 'ALLERGIES_RECORDED',
        version: 2,
        activeAllergyCount: 1,
        lastChange: { automatic: true, kind: 'RECTIFIED' },
      });
      expect(cur.lastChange.reason).toMatch(/registró una alergia activa/);
      const [auto] = await ctx.db.auditLog.findMany({
        where: {
          patientId: w.patientId,
          action: 'CLINICAL_ALLERGY_ASSESSMENT_AUTO_UPDATED',
        },
      });
      expect(auto!.summary).toMatchObject({
        version: 2,
        automatic: true,
        fields: ['status'],
      });
      expect(JSON.stringify(auto)).not.toContain('ALLERGIES_RECORDED');
    });

    it('al quedar sin alergias activas (desactivar o marcar error) vuelve a NOT_ASKED; con otra alergia activa se mantiene; reactivar la restablece', async () => {
      const w = await world();
      const a = (
        await post(w.dentist.token, w.patientId, '/history', allergy()).expect(
          201,
        )
      ).body;
      const b = (
        await post(w.dentist.token, w.patientId, '/history', allergy()).expect(
          201,
        )
      ).body;
      await post(
        w.dentist.token,
        w.patientId,
        `/history/${a.id}/deactivate`,
        change(1),
      ).expect(200);
      expect(await current(w)).toMatchObject({
        status: 'ALLERGIES_RECORDED',
        version: 1,
        activeAllergyCount: 1,
      }); // aún hay una
      await post(
        w.dentist.token,
        w.patientId,
        `/history/${b.id}/mark-error`,
        change(1),
      ).expect(200);
      expect(await current(w)).toMatchObject({
        status: 'NOT_ASKED',
        version: 2,
        activeAllergyCount: 0,
      });
      await post(
        w.dentist.token,
        w.patientId,
        `/history/${a.id}/reactivate`,
        change(2),
      ).expect(200);
      expect(await current(w)).toMatchObject({
        status: 'ALLERGIES_RECORDED',
        version: 3,
      });
      await post(
        w.dentist.token,
        w.patientId,
        `/history/${a.id}/deactivate`,
        change(3),
      ).expect(200);
      // ahora sí puede declararse "sin alergias conocidas"
      await putA(
        w.dentist.token,
        w.patientId,
        assess({ expectedVersion: 4, reason: 'Se confirma con el paciente' }),
      ).expect(200);
      const chain = await rows(w.patientId);
      expect(chain.map((r) => r.status)).toEqual([
        'ALLERGIES_RECORDED',
        'NOT_ASKED',
        'ALLERGIES_RECORDED',
        'NOT_ASKED',
        'NO_KNOWN_ALLERGIES',
      ]);
      expect(chain.map((r) => r.automatic)).toEqual([
        true,
        true,
        true,
        true,
        false,
      ]);
      expect(chain[0]!.changeReason).toBeNull(); // el alta no exige motivo
      expect(
        chain.slice(1).every((r) => (r.changeReason ?? '').length >= 3),
      ).toBe(true);
      expect(chain.filter((r) => r.currentKey !== null)).toHaveLength(1);
    });

    it('rectificar una alergia (sin cambiar su estado) no crea versiones de evaluación', async () => {
      const w = await world();
      const a = (
        await post(w.dentist.token, w.patientId, '/history', allergy()).expect(
          201,
        )
      ).body;
      await post(
        w.dentist.token,
        w.patientId,
        `/history/${a.id}/rectify`,
        change(1, { severity: 'MILD' }),
      ).expect(200);
      expect(await rows(w.patientId)).toHaveLength(1);
    });

    it('el resumen clínico completo incluye la evaluación; la vista del asistente, no', async () => {
      const w = await world();
      await post(w.dentist.token, w.patientId, '/history', allergy()).expect(
        201,
      );
      const full = (
        await ctx
          .http()
          .get(`/v1/patients/${w.patientId}/clinical-summary`)
          .set(bearer(w.dentist.token))
          .expect(200)
      ).body;
      expect(full.allergyAssessment).toMatchObject({
        status: 'ALLERGIES_RECORDED',
        version: 1,
      });
      const limited = (
        await ctx
          .http()
          .get(`/v1/patients/${w.patientId}/clinical-summary`)
          .set(bearer(w.assistant.token))
          .expect(200)
      ).body;
      expect(limited).not.toHaveProperty('allergyAssessment');
      expect(JSON.stringify(limited)).not.toMatch(
        /ALLERGIES_RECORDED|NO_KNOWN|NOT_ASKED/,
      );
    });

    it('alergias anteriores a la tabla (sin filas) se muestran como ALLERGIES_RECORDED derivado', async () => {
      const w = await world();
      const itemId = crypto.randomUUID();
      await ctx.db.clinicalHistoryEntry.create({
        data: {
          clinicId: w.clinic.id,
          patientId: w.patientId,
          itemId,
          version: 1,
          currentKey: itemId,
          kind: 'ALLERGY',
          label: 'Anterior',
          source: 'PATIENT',
          changeKind: 'CREATED',
          createdById: w.dentist.user.id,
        },
      });
      expect(await current(w)).toMatchObject({
        status: 'ALLERGIES_RECORDED',
        version: 0,
        derived: true,
        activeAllergyCount: 1,
      });
      await putA(w.dentist.token, w.patientId, assess()).expect(409);
      await post(
        w.dentist.token,
        w.patientId,
        `/history/${itemId}/deactivate`,
        change(1),
      ).expect(200);
      expect(await rows(w.patientId)).toHaveLength(0); // sin evaluación previa que cerrar
    });
  });

  describe('base de datos', () => {
    it('impone la invariante, el encadenamiento y el historial inmutable', async () => {
      const w = await world();
      const sql = (t: string, ...v: unknown[]) =>
        ctx.db.$executeRawUnsafe(t, ...v);
      const mk = (over: Record<string, unknown> = {}) => ({
        clinicId: w.clinic.id,
        patientId: w.patientId,
        version: 1,
        currentKey: w.patientId,
        status: 'NO_KNOWN_ALLERGIES' as const,
        assessedOn: new Date('2024-01-01'),
        source: 'PATIENT' as const,
        changeKind: 'CREATED' as const,
        createdById: w.dentist.user.id,
        ...over,
      });
      // ALLERGIES_RECORDED sin alergias activas
      await expect(
        ctx.db.clinicalAllergyAssessment.create({
          data: mk({ status: 'ALLERGIES_RECORDED' }),
        }),
      ).rejects.toThrow(/al menos una alergia activa/);
      // alta sin motivo: permitido; el estado válido queda
      const v1 = await ctx.db.clinicalAllergyAssessment.create({ data: mk() });
      // versión 2 sin motivo
      await ctx.db.clinicalAllergyAssessment.update({
        where: { id: v1.id },
        data: { currentKey: null },
      });
      await expect(
        ctx.db.clinicalAllergyAssessment.create({
          data: mk({
            version: 2,
            supersedesId: v1.id,
            changeKind: 'RECTIFIED',
            status: 'NOT_ASKED',
          }),
        }),
      ).rejects.toThrow(/motivo/);
      await expect(
        sql(
          'UPDATE clinical_allergy_assessments SET current_key = patient_id WHERE id = ?',
          v1.id,
        ),
      ).rejects.toThrow(/inmutable/); // no se reabre
      expect((await rows(w.patientId))[0]!.currentKey).toBeNull(); // no se puede reabrir
      await expect(
        sql('DELETE FROM clinical_allergy_assessments WHERE id = ?', v1.id),
      ).rejects.toThrow(/no se eliminan/);
      await expect(
        sql(
          "UPDATE clinical_allergy_assessments SET status = 'NOT_ASKED' WHERE id = ?",
          v1.id,
        ),
      ).rejects.toThrow(/inmutable/);
      // con una alergia activa, NO_KNOWN_ALLERGIES es imposible
      const w2 = await world();
      await post(w2.dentist.token, w2.patientId, '/history', allergy()).expect(
        201,
      );
      await ctx.db.clinicalAllergyAssessment.updateMany({
        where: { patientId: w2.patientId },
        data: { currentKey: null },
      });
      await expect(
        ctx.db.clinicalAllergyAssessment.create({
          data: mk({
            clinicId: w2.clinic.id,
            patientId: w2.patientId,
            currentKey: w2.patientId,
            version: 2,
            supersedesId: (await rows(w2.patientId))[0]!.id,
            changeKind: 'RECTIFIED',
            changeReason: 'Motivo válido',
            status: 'NO_KNOWN_ALLERGIES',
          }),
        }),
      ).rejects.toThrow(/existen alergias activas/);
      // otra clínica: FK compuesta
      await expect(
        ctx.db.clinicalAllergyAssessment.create({
          data: mk({
            clinicId: (await fx.clinic()).id,
            currentKey: w.patientId,
          }),
        }),
      ).rejects.toThrow();
    });
  });

  describe('motivo del alta: opcional; cambios posteriores: obligatorio', () => {
    it('antecedentes y alertas se pueden dar de alta sin motivo (la fuente sí es obligatoria); si se informa, debe ser significativo', async () => {
      const w = await world();
      const e = expectStatus(
        await post(w.dentist.token, w.patientId, '/history', {
          kind: 'BACKGROUND',
          label: uniq('Diabetes-'),
          source: 'DOCUMENT',
        }),
        201,
      ).body;
      expect(e.lastChange).toMatchObject({ kind: 'CREATED', reason: null });
      const al = expectStatus(
        await post(w.dentist.token, w.patientId, '/alerts', {
          severity: 'INFO',
          text: uniq('Alerta-'),
          source: 'PROFESSIONAL',
        }),
        201,
      ).body;
      expect(al.lastChange).toMatchObject({ kind: 'CREATED', reason: null });
      await post(w.dentist.token, w.patientId, '/history', {
        kind: 'BACKGROUND',
        label: uniq('X-'),
        source: 'DOCUMENT',
        reason: 'ab',
      }).expect(400);
      await post(w.dentist.token, w.patientId, '/history', {
        kind: 'BACKGROUND',
        label: uniq('X-'),
      }).expect(400); // falta la fuente
      await post(w.dentist.token, w.patientId, '/alerts', {
        severity: 'INFO',
        text: uniq('Alerta-'),
      }).expect(400); // falta la fuente
      // desde la versión 2, siempre con motivo (API y base de datos)
      for (const action of ['correct', 'rectify', 'deactivate', 'mark-error']) {
        const body =
          action === 'correct' || action === 'rectify'
            ? { expectedVersion: 1, label: uniq('Nuevo-') }
            : { expectedVersion: 1 };
        await post(
          w.dentist.token,
          w.patientId,
          `/history/${e.id}/${action}`,
          body,
        ).expect(400);
      }
      await post(w.dentist.token, w.patientId, `/alerts/${al.id}/deactivate`, {
        expectedVersion: 1,
      }).expect(400);
      expect(
        await ctx.db.clinicalHistoryEntry.count({ where: { itemId: e.id } }),
      ).toBe(1);
      const [v1] = await ctx.db.clinicalHistoryEntry.findMany({
        where: { itemId: e.id },
      });
      await ctx.db.clinicalHistoryEntry.update({
        where: { id: v1!.id },
        data: { currentKey: null },
      });
      await expect(
        ctx.db.clinicalHistoryEntry.create({
          data: {
            clinicId: w.clinic.id,
            patientId: w.patientId,
            itemId: e.id,
            version: 2,
            supersedesId: v1!.id,
            currentKey: e.id,
            kind: 'BACKGROUND',
            label: 'x',
            source: 'PATIENT',
            changeKind: 'CORRECTED',
            createdById: w.dentist.user.id,
          },
        }),
      ).rejects.toThrow(/motivo/);
    });

    it('con motivo, los cambios siguen versionados y trazables', async () => {
      const w = await world();
      const e = (
        await post(w.dentist.token, w.patientId, '/history', {
          kind: 'BACKGROUND',
          label: uniq('Hta-'),
          source: 'PATIENT',
        }).expect(201)
      ).body;
      await post(
        w.dentist.token,
        w.patientId,
        `/history/${e.id}/correct`,
        change(1, { label: uniq('Hta2-'), reason: 'Error de digitación' }),
      ).expect(200);
      const versions = (
        await get(
          w.dentist.token,
          w.patientId,
          `/history/${e.id}/versions`,
        ).expect(200)
      ).body;
      expect(
        versions.map(
          (v: { lastChange: { reason: string | null } }) => v.lastChange.reason,
        ),
      ).toEqual(['Error de digitación', null]);
    });
  });

  describe('vista del asistente (sin cambios)', () => {
    it('sigue viendo solo alertas críticas activas con su etiqueta breve; nada de antecedentes, observaciones ni historial', async () => {
      const w = await world();
      const crit = (
        await post(
          w.dentist.token,
          w.patientId,
          '/history',
          allergy({
            isCritical: true,
            label: uniq('Látex-'),
            observations: uniq('NOTA-'),
            condition: uniq('Reaccion-'),
          }),
        ).expect(201)
      ).body;
      await post(
        w.dentist.token,
        w.patientId,
        '/history',
        allergy({ label: uniq('NoCritica-') }),
      ).expect(201);
      await post(w.dentist.token, w.patientId, '/history', {
        kind: 'BACKGROUND',
        label: uniq('Antecedente-'),
        source: 'PATIENT',
      }).expect(201);
      await putA(w.dentist.token, w.patientId, assess()).expect(409);
      const res = (
        await get(w.assistant.token, w.patientId, '/alerts').expect(200)
      ).body;
      expect(res.alerts).toHaveLength(1);
      expect(res.alerts[0]).toMatchObject({
        id: crit.id,
        origin: 'ALLERGY',
        severity: 'CRITICAL',
        label: crit.label,
      });
      expect(Object.keys(res.alerts[0]).sort()).toEqual([
        'id',
        'label',
        'origin',
        'severity',
        'validUntil',
      ]);
      expect(JSON.stringify(res)).not.toMatch(
        /NOTA-|Reaccion-|NoCritica-|Antecedente-/,
      );
      for (const p of [
        '/history',
        '/allergy-assessment',
        '/allergy-assessment/versions',
      ]) {
        expect(
          (await get(w.assistant.token, w.patientId, p).expect(403)).body.code,
        ).toBe('CLINICAL_LIMITED_VIEW');
      }
      await putA(w.assistant.token, w.patientId, assess()).expect(403);
      await post(
        w.dentist.token,
        w.patientId,
        `/history/${crit.id}/deactivate`,
        change(1),
      ).expect(200);
      expect(
        (await get(w.assistant.token, w.patientId, '/alerts').expect(200)).body
          .alerts,
      ).toEqual([]); // desactivada: ya no se muestra
    });
  });

  describe('acceso y aislamiento', () => {
    it('administración, sin relación, con relación revocada o de otra clínica no leen ni escriben la evaluación (recepción solo lee)', async () => {
      const w = await world();
      await putA(w.dentist.token, w.patientId, assess()).expect(200);
      // Recepción solo tiene vista de lectura: lee (200) pero no escribe (403)
      await get(w.reception.token, w.patientId, '/allergy-assessment').expect(200);
      await get(w.reception.token, GHOST, '/allergy-assessment').expect(404);
      await putA(
        w.reception.token,
        w.patientId,
        assess({ expectedVersion: 1, reason: 'Recepción no escribe' }),
      ).expect(403);
      for (const token of [w.admin.token]) {
        const real = await get(
          token,
          w.patientId,
          '/allergy-assessment',
        ).expect(403);
        const ghost = await get(token, GHOST, '/allergy-assessment').expect(
          403,
        );
        expect(real.body.message).toBe(ghost.body.message);
        await putA(
          token,
          w.patientId,
          assess({ expectedVersion: 1, reason: 'Intento sin permiso' }),
        ).expect(403);
      }
      const stranger = await actorIn(ctx, fx, 'DENTIST', {
        clinicId: w.clinic.id,
      });
      expect(
        (
          await get(stranger.token, w.patientId, '/allergy-assessment').expect(
            403,
          )
        ).body.code,
      ).toBe('NO_CARE_RELATIONSHIP');
      await putA(
        stranger.token,
        w.patientId,
        assess({ expectedVersion: 1, reason: 'Intento sin relación' }),
      ).expect(403);
      // otra clínica: 404 idéntico al inexistente
      const other = await fx.clinic();
      const dentistB = await actorIn(ctx, fx, 'DENTIST', {
        clinicId: other.id,
      });
      for (const p of ['/allergy-assessment', '/allergy-assessment/versions']) {
        const foreign = await get(dentistB.token, w.patientId, p).expect(404);
        const ghost = await get(dentistB.token, GHOST, p).expect(404);
        expect(foreign.body.message).toBe(ghost.body.message);
      }
      await putA(
        dentistB.token,
        w.patientId,
        assess({ expectedVersion: 1, reason: 'Intento ajeno' }),
      ).expect(404);
      // relación revocada
      await revokeCareReq(ctx, w.reception.token, w.rel.id).expect(200);
      await get(w.dentist.token, w.patientId, '/allergy-assessment').expect(
        403,
      );
      await putA(
        w.dentist.token,
        w.patientId,
        assess({ expectedVersion: 1, reason: 'Tarde' }),
      ).expect(403);
      expect(await rows(w.patientId)).toHaveLength(1);
    });

    it('relación de otra sede: se lee desde cualquier sede, pero la evaluación solo se declara en la sede de origen', async () => {
      const w = await world();
      const bA = await fx.branch(w.clinic.id);
      const bB = await fx.branch(w.clinic.id);
      const d = await fx.user();
      await fx.assign(d.id, 'DENTIST', {
        clinicId: w.clinic.id,
        branchId: bA.id,
      });
      await fx.assign(d.id, 'DENTIST', {
        clinicId: w.clinic.id,
        branchId: bB.id,
      });
      const p = (await createPatient(ctx, w.reception.token)).id;
      await assignCare(ctx, w.reception.token, p, d.id, { branchId: bB.id });
      const inA = await loginInContext(ctx, d.email, {
        clinicId: w.clinic.id,
        branchId: bA.id,
      });
      const inB = await loginInContext(ctx, d.email, {
        clinicId: w.clinic.id,
        branchId: bB.id,
      });
      await get(inA, p, '/allergy-assessment').expect(200);
      expect((await putA(inA, p, assess()).expect(403)).body.code).toBe(
        'WRONG_BRANCH',
      );
      await putA(inB, p, assess()).expect(200);
    });

    it('Director: sin autorización no lee; con ella lee la evaluación y sus versiones, pero nunca la declara', async () => {
      const w = await world();
      await putA(w.dentist.token, w.patientId, assess()).expect(200);
      expect(
        (
          await get(
            w.director.token,
            w.patientId,
            '/allergy-assessment',
          ).expect(403)
        ).body.code,
      ).toBe('CLINICAL_JUSTIFICATION_REQUIRED');
      expectStatus(await grantReadAll(ctx, w.director.token, w.patientId), 201);
      expect(
        (
          await get(
            w.director.token,
            w.patientId,
            '/allergy-assessment',
          ).expect(200)
        ).body,
      ).toMatchObject({ status: 'NO_KNOWN_ALLERGIES' });
      await get(
        w.director.token,
        w.patientId,
        '/allergy-assessment/versions',
      ).expect(200);
      await putA(
        w.director.token,
        w.patientId,
        assess({ expectedVersion: 1, reason: 'El Director no escribe' }),
      ).expect(403);
      const reads = await ctx.db.auditLog.findMany({
        where: { patientId: w.patientId, action: 'CLINICAL_READ_ALL_READ' },
      });
      expect(
        reads
          .map((r) => String((r.summary as { sections: string[] }).sections[0]))
          .sort((x, y) => x.localeCompare(y)),
      ).toEqual(['allergy_assessment', 'allergy_assessment_versions']);
    });

    it('si falla la auditoría, la lectura se deniega (503) y la declaración se revierte', async () => {
      const w = await world();
      await putA(w.dentist.token, w.patientId, assess()).expect(200);
      const audit = ctx.app.get(AuditService);
      const original = audit.record.bind(audit);
      vi.spyOn(audit, 'record').mockImplementation(async (entry, tx) => {
        if (
          entry.action === 'CLINICAL_RECORD_VIEWED' ||
          entry.action === 'CLINICAL_ALLERGY_ASSESSMENT_SET'
        )
          throw new Error('auditoría caída');
        return original(entry, tx);
      });
      const read = await get(
        w.dentist.token,
        w.patientId,
        '/allergy-assessment',
      ).expect(503);
      expect(read.text).not.toContain('NO_KNOWN');
      expect(
        (
          await putA(
            w.dentist.token,
            w.patientId,
            assess({
              status: 'NOT_ASKED',
              expectedVersion: 1,
              reason: 'Cambio que no debe quedar',
            }),
          )
        ).status,
      ).toBeGreaterThanOrEqual(500);
      vi.restoreAllMocks();
      const chain = await rows(w.patientId);
      expect(chain).toHaveLength(1);
      expect(chain[0]!.currentKey).toBe(w.patientId); // la vigente sigue vigente
    });
  });

  describe('concurrencia', () => {
    const sound = async (patientId: string) => {
      const chain = await rows(patientId);
      expect(chain.map((r) => r.version)).toEqual(chain.map((_, i) => i + 1));
      expect(chain.filter((r) => r.currentKey !== null)).toHaveLength(1);
      return chain;
    };
    const consistent = async (w: W) => {
      const active = await ctx.db.clinicalHistoryEntry.count({
        where: {
          patientId: w.patientId,
          kind: 'ALLERGY',
          status: 'ACTIVE',
          currentKey: { not: null },
        },
      });
      const cur = (await rows(w.patientId)).find((r) => r.currentKey !== null);
      if (active > 0) expect(cur?.status).toBe('ALLERGIES_RECORDED');
      else expect(cur?.status ?? 'NOT_ASKED').not.toBe('ALLERGIES_RECORDED');
    };

    it('declarar NO_KNOWN_ALLERGIES mientras se registra una alergia: nunca coexisten', async () => {
      for (let round = 0; round < 8; round++) {
        const w = await world();
        const [declared, created] = await Promise.all([
          putA(w.dentist.token, w.patientId, assess()),
          post(w.dentist.token, w.patientId, '/history', allergy()),
        ]);
        expect(created.status, `ronda ${round}`).toBe(201);
        expect([200, 409], `ronda ${round}`).toContain(declared.status);
        await consistent(w);
        const chain = await sound(w.patientId);
        expect(chain.at(-1)!.status, `ronda ${round}`).toBe(
          'ALLERGIES_RECORDED',
        );
        if (declared.status === 200)
          expect(chain.map((r) => r.status)).toEqual([
            'NO_KNOWN_ALLERGIES',
            'ALLERGIES_RECORDED',
          ]);
      }
    });

    it('dos declaraciones simultáneas sobre la misma versión: una prospera', async () => {
      const w = await world();
      const results = await Promise.all([
        putA(w.dentist.token, w.patientId, assess({ source: 'PATIENT' })),
        putA(w.dentist.token, w.patientId, assess({ source: 'GUARDIAN' })),
        putA(w.dentist.token, w.patientId, assess({ source: 'DOCUMENT' })),
      ]);
      expect(results.map((r) => r.status).sort((x, y) => x - y)).toEqual([
        200, 409, 409,
      ]);
      expect(await sound(w.patientId)).toHaveLength(1);
    });

    it('varias altas de alergia a la vez producen una sola versión automática; desactivarlas a la vez deja NOT_ASKED', async () => {
      const w = await world();
      const created = await Promise.all(
        Array.from({ length: 4 }, () =>
          post(w.dentist.token, w.patientId, '/history', allergy()),
        ),
      );
      expect(created.every((r) => r.status === 201)).toBe(true);
      expect(await sound(w.patientId)).toHaveLength(1);
      const ids = created.map((r) => r.body.id as string);
      const off = await Promise.all(
        ids.map((id) =>
          post(
            w.dentist.token,
            w.patientId,
            `/history/${id}/deactivate`,
            change(1),
          ),
        ),
      );
      expect(off.every((r) => r.status === 200)).toBe(true);
      const chain = await sound(w.patientId);
      expect(chain.map((r) => r.status)).toEqual([
        'ALLERGIES_RECORDED',
        'NOT_ASKED',
      ]);
      await consistent(w);
    });

    it('desactivar la última alergia mientras se declara NO_KNOWN_ALLERGIES: el resultado siempre es coherente', async () => {
      for (let round = 0; round < 6; round++) {
        const w = await world();
        const a = (
          await post(
            w.dentist.token,
            w.patientId,
            '/history',
            allergy(),
          ).expect(201)
        ).body;
        const [off, declared] = await Promise.all([
          post(
            w.dentist.token,
            w.patientId,
            `/history/${a.id}/deactivate`,
            change(1),
          ),
          putA(
            w.dentist.token,
            w.patientId,
            assess({
              expectedVersion: 1,
              reason: 'Se confirma con el paciente',
            }),
          ),
        ]);
        expect(off.status, `ronda ${round}`).toBe(200);
        expect([200, 409], `ronda ${round}`).toContain(declared.status);
        await consistent(w);
        await sound(w.patientId);
      }
    });

    it('revocar el acceso mientras se declara: toda declaración confirmada quedó auditada y después ya no hay ninguna', async () => {
      for (let round = 0; round < 4; round++) {
        const w = await world();
        const writes = Array.from({ length: 4 }, () =>
          putA(w.dentist.token, w.patientId, assess()),
        );
        const [revoked, ...results] = await Promise.all([
          revokeCareReq(ctx, w.reception.token, w.rel.id),
          ...writes,
        ]);
        expect(revoked.status).toBe(200);
        expect(
          results.every((r) => [200, 403, 409].includes(r.status)),
          `ronda ${round}`,
        ).toBe(true);
        const ok = results.filter((r) => r.status === 200).length;
        expect(ok).toBeLessThanOrEqual(1); // la misma versión esperada: solo una puede prosperar
        expect(
          await ctx.db.clinicalAllergyAssessment.count({
            where: { patientId: w.patientId },
          }),
        ).toBe(ok);
        expect(
          await ctx.db.auditLog.count({
            where: {
              patientId: w.patientId,
              action: 'CLINICAL_ALLERGY_ASSESSMENT_SET',
            },
          }),
        ).toBe(ok);
        await putA(
          w.dentist.token,
          w.patientId,
          assess({ expectedVersion: ok, reason: 'Ya revocada' }),
        ).expect(403);
      }
    });
  });
});
