import type { LoggerService } from '@nestjs/common';
import { vi } from 'vitest';
import { AuditService } from '../src/audit/audit.service.js';
import {
  actorIn,
  assignCare,
  bearer,
  clinicalConsentBody,
  createPatient,
  createTestContext,
  Fixtures,
  grantReadAll,
  loginInContext,
  revokeCareReq,
  type TestContext,
  uniq,
} from './helpers/app.js';

class CapturingLogger implements LoggerService {
  lines: string[] = [];
  private push(level: string, m: unknown, p: unknown[]) {
    const safe = (v: unknown) =>
      typeof v === 'string' ? v : JSON.stringify(v);
    this.lines.push(`${level} ${[m, ...p].map(safe).join(' ')}`);
  }
  log(m: unknown, ...p: unknown[]) {
    this.push('log', m, p);
  }
  error(m: unknown, ...p: unknown[]) {
    this.push('error', m, p);
  }
  warn(m: unknown, ...p: unknown[]) {
    this.push('warn', m, p);
  }
  debug(m: unknown, ...p: unknown[]) {
    this.push('debug', m, p);
  }
  verbose(m: unknown, ...p: unknown[]) {
    this.push('verbose', m, p);
  }
  fatal(m: unknown, ...p: unknown[]) {
    this.push('fatal', m, p);
  }
}

const GHOST = '8e5f2c5a-7d3e-4f52-9d7c-3b7a1e9d6c11';
const expectStatus = <T extends { status: number; body: unknown }>(
  res: T,
  status: number,
): T => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res;
};

describe('Visitas, diagnósticos y procedimientos (3.3)', () => {
  const logger = new CapturingLogger();
  let ctx: TestContext;
  let fx: Fixtures;
  beforeAll(async () => {
    ctx = await createTestContext({ logger });
    fx = new Fixtures(ctx.db);
  });
  afterAll(() => ctx.close());
  afterEach(() => vi.restoreAllMocks());

  async function world() {
    const clinic = await fx.clinic();
    const branchA = await fx.branch(clinic.id);
    const branchB = await fx.branch(clinic.id);
    const admin = await actorIn(ctx, fx, 'CLINIC_ADMIN', {
      clinicId: clinic.id,
    });
    const reception = await actorIn(ctx, fx, 'RECEPTIONIST', {
      clinicId: clinic.id,
    });
    const cashier = await actorIn(ctx, fx, 'CASHIER', { clinicId: clinic.id });
    const assistant = await actorIn(ctx, fx, 'ASSISTANT', {
      clinicId: clinic.id,
    });
    const director = await actorIn(ctx, fx, 'CLINICAL_DIRECTOR', {
      clinicId: clinic.id,
    });
    // odontólogo asignado a las dos sedes (asignaciones por sede), con contexto en la sede A
    const dUser = await fx.user();
    await fx.assign(dUser.id, 'DENTIST', {
      clinicId: clinic.id,
      branchId: branchA.id,
    });
    await fx.assign(dUser.id, 'DENTIST', {
      clinicId: clinic.id,
      branchId: branchB.id,
    });
    const dentist = {
      user: dUser,
      token: await loginInContext(ctx, dUser.email, {
        clinicId: clinic.id,
        branchId: branchA.id,
      }),
      tokenB: await loginInContext(ctx, dUser.email, {
        clinicId: clinic.id,
        branchId: branchB.id,
      }),
    };
    const { id: patientId } = await createPatient(ctx, reception.token, {
      lastName: uniq('Apellido'),
    });
    const rel = await assignCare(ctx, reception.token, patientId, dUser.id);
    return {
      clinic,
      branchA,
      branchB,
      admin,
      reception,
      cashier,
      assistant,
      director,
      dentist,
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
  const post = (t: string, id: string, p: string, b: unknown = {}) =>
    ctx
      .http()
      .post(`${base(id)}${p}`)
      .set(bearer(t))
      .send(b as object);
  const defBody = (over: Record<string, unknown> = {}) => ({
    code: uniq('PROC').toUpperCase(),
    name: uniq('Procedimiento '),
    requiresClinicalConsent: false,
    ...over,
  });
  const mkDef = async (w: W, over: Record<string, unknown> = {}) =>
    expectStatus(
      await ctx
        .http()
        .post('/v1/procedure-definitions')
        .set(bearer(w.admin.token))
        .send(defBody(over)),
      201,
    ).body as {
      id: string;
      code: string;
      name: string;
      version: number;
      requiresClinicalConsent: boolean;
    };
  const openVisit = async (
    w: W,
    token = w.dentist.token,
    patientId = w.patientId,
    body: Record<string, unknown> = { reason: 'Control' },
  ) =>
    expectStatus(await post(token, patientId, '/visits', body), 201).body as {
      id: string;
      version: number;
      warnings: string[];
      visitNumber: number;
    };
  const mkProc = async (
    w: W,
    visitId: string,
    definitionId: string,
    over: Record<string, unknown> = {},
    token = w.dentist.token,
  ) =>
    expectStatus(
      await post(token, w.patientId, `/visits/${visitId}/procedures`, {
        definitionId,
        notes: uniq('NOTAS-'),
        ...over,
      }),
      201,
    ).body as { id: string; version: number };
  const mkDiag = async (
    w: W,
    visitId: string,
    over: Record<string, unknown> = {},
    token = w.dentist.token,
  ) =>
    expectStatus(
      await post(token, w.patientId, `/visits/${visitId}/diagnoses`, {
        description: uniq('Diagnostico-'),
        certainty: 'PRESUMPTIVE',
        ...over,
      }),
      201,
    ).body as { id: string; version: number; description: string };
  const grantConsent = (w: W, patientId = w.patientId) =>
    ctx
      .http()
      .post(`/v1/patients/${patientId}/consents`)
      .set(bearer(w.reception.token))
      .send(clinicalConsentBody())
      .expect(201);
  const chain = (
    table: 'clinicalDiagnosis' | 'clinicalProcedure',
    itemId: string,
  ) =>
    (
      ctx.db[table] as unknown as {
        findMany: (a: object) => Promise<
          {
            version: number;
            currentKey: string | null;
            changeKind: string;
            status: string;
          }[]
        >;
      }
    ).findMany({ where: { itemId }, orderBy: { version: 'asc' } });

  describe('catálogo de procedimientos por clínica', () => {
    it('administración configura el catálogo (código único por clínica, versionado y auditado); es de apoyo, no una guía', async () => {
      const w = await world();
      const body = defBody({
        requiresClinicalConsent: true,
        description: 'Definición propia de la clínica',
      });
      const d = expectStatus(
        await ctx
          .http()
          .post('/v1/procedure-definitions')
          .set(bearer(w.admin.token))
          .send({ ...body, code: ` ${body.code.toLowerCase()} ` }),
        201,
      ).body;
      expect(d).toMatchObject({
        code: body.code,
        requiresClinicalConsent: true,
        status: 'ACTIVE',
        version: 1,
        administrativeAidOnly: true,
      });
      const dup = await ctx
        .http()
        .post('/v1/procedure-definitions')
        .set(bearer(w.admin.token))
        .send(body)
        .expect(409);
      expect(dup.body.code).toBe('CODE_EXISTS');
      // otra clínica puede usar el mismo código y no ve el catálogo ajeno
      const other = await actorIn(ctx, fx, 'CLINIC_ADMIN', {
        clinicId: (await fx.clinic()).id,
      });
      await ctx
        .http()
        .post('/v1/procedure-definitions')
        .set(bearer(other.token))
        .send(body)
        .expect(201);
      expect(
        (
          await ctx
            .http()
            .get('/v1/procedure-definitions')
            .set(bearer(other.token))
            .expect(200)
        ).body,
      ).toHaveLength(1);
      expect(
        (
          await ctx
            .http()
            .get('/v1/procedure-definitions')
            .set(bearer(w.admin.token))
            .expect(200)
        ).body.map((x: { id: string }) => x.id),
      ).toEqual([d.id]);

      const upd = expectStatus(
        await ctx
          .http()
          .patch(`/v1/procedure-definitions/${d.id}`)
          .set(bearer(w.admin.token))
          .send({
            expectedVersion: 1,
            reason: 'La clínica ya no lo exige',
            requiresClinicalConsent: false,
          }),
        200,
      );
      expect(upd.body).toMatchObject({
        version: 2,
        requiresClinicalConsent: false,
      });
      await ctx
        .http()
        .patch(`/v1/procedure-definitions/${d.id}`)
        .set(bearer(w.admin.token))
        .send({ expectedVersion: 1, reason: 'Versión vieja', name: 'Otro' })
        .expect(409);
      await ctx
        .http()
        .patch(`/v1/procedure-definitions/${d.id}`)
        .set(bearer(w.admin.token))
        .send({ expectedVersion: 2, name: 'Sin motivo' })
        .expect(400);
      await ctx
        .http()
        .patch(`/v1/procedure-definitions/${d.id}`)
        .set(bearer(w.admin.token))
        .send({ expectedVersion: 2, reason: 'Sin cambios' })
        .expect(409);
      await ctx
        .http()
        .post(`/v1/procedure-definitions/${d.id}/deactivate`)
        .set(bearer(w.admin.token))
        .send({ expectedVersion: 2, reason: 'Ya no se ofrece' })
        .expect(200);
      await ctx
        .http()
        .post(`/v1/procedure-definitions/${d.id}/reactivate`)
        .set(bearer(w.admin.token))
        .send({ expectedVersion: 3, reason: 'Se ofrece de nuevo' })
        .expect(200);
      const logs = await ctx.db.auditLog.findMany({
        where: { entityId: d.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(logs.map((l) => l.action)).toEqual([
        'PROCEDURE_DEFINITION_CREATED',
        'PROCEDURE_DEFINITION_UPDATED',
        'PROCEDURE_DEFINITION_DEACTIVATED',
        'PROCEDURE_DEFINITION_REACTIVATED',
      ]);
      expect(logs[1]!.summary).toMatchObject({
        version: 2,
        fields: ['requiresClinicalConsent'],
        requiresClinicalConsent: false,
      });
      await expect(
        ctx.db.procedureDefinition.delete({ where: { id: d.id } }),
      ).rejects.toThrow(/no se elimina/);
      await expect(
        ctx.db.procedureDefinition.update({
          where: { id: d.id },
          data: { code: 'OTRO' },
        }),
      ).rejects.toThrow(/inmutables/);
    });

    it('lo ven administración, Director y odontólogos; lo configuran administración y Director; recepción, caja, asistente y plataforma, no', async () => {
      const w = await world();
      const { user } = await fx.userWithRole('PLATFORM_ADMIN');
      const platform = await loginInContext(ctx, user.email);
      for (const t of [w.admin.token, w.director.token, w.dentist.token])
        await ctx
          .http()
          .get('/v1/procedure-definitions')
          .set(bearer(t))
          .expect(200);
      for (const t of [
        w.reception.token,
        w.cashier.token,
        w.assistant.token,
        platform,
      ]) {
        await ctx
          .http()
          .get('/v1/procedure-definitions')
          .set(bearer(t))
          .expect(403);
        await ctx
          .http()
          .post('/v1/procedure-definitions')
          .set(bearer(t))
          .send(defBody())
          .expect(403);
      }
      await ctx
        .http()
        .post('/v1/procedure-definitions')
        .set(bearer(w.dentist.token))
        .send(defBody())
        .expect(403);
      await ctx
        .http()
        .post('/v1/procedure-definitions')
        .set(bearer(w.director.token))
        .send(defBody())
        .expect(201);
      await ctx
        .http()
        .post('/v1/procedure-definitions')
        .set(bearer(w.admin.token))
        .send(defBody({ code: 'mal código!' }))
        .expect(400);
    });
  });

  describe('visita', () => {
    it('el odontólogo con relación la abre en su sede: numerada, auditada, y el consentimiento faltante solo avisa', async () => {
      const w = await world();
      const v = expectStatus(
        await post(w.dentist.token, w.patientId, '/visits', {
          reason: 'Control de rutina',
        }),
        201,
      ).body;
      expect(v).toMatchObject({
        patientId: w.patientId,
        visitNumber: 1,
        branchId: w.branchA.id,
        responsibleUserId: w.dentist.user.id,
        status: 'OPEN',
        reason: 'Control de rutina',
        version: 1,
        careRelationshipId: w.rel.id,
      });
      expect(v.warnings).toContain('CLINICAL_CONSENT_MISSING'); // aviso, no bloqueo
      const log = await ctx.db.auditLog.findFirstOrThrow({
        where: { entityId: v.id, action: 'CLINICAL_VISIT_OPENED' },
      });
      expect(log).toMatchObject({
        userId: w.dentist.user.id,
        patientId: w.patientId,
        clinicId: w.clinic.id,
      });
      expect(log.summary).toMatchObject({ visitNumber: 1, version: 1 });
      expect(JSON.stringify(log)).not.toContain('Control de rutina');
      // una visita abierta por paciente y odontólogo
      expect(
        (await post(w.dentist.token, w.patientId, '/visits').expect(409)).body
          .code,
      ).toBe('VISIT_ALREADY_OPEN');
      await post(w.dentist.token, w.patientId, `/visits/${v.id}/close`, {
        expectedVersion: 1,
      }).expect(200);
      expect((await openVisit(w)).visitNumber).toBe(2);
    });

    it('exige sede en el contexto, relación vigente y paciente activo; recepción, caja y administración no abren visitas', async () => {
      const w = await world();
      // asignación de toda la clínica: el contexto no trae sede
      const wide = await actorIn(ctx, fx, 'DENTIST', { clinicId: w.clinic.id });
      await assignCare(ctx, w.reception.token, w.patientId, wide.user.id);
      expect(
        (await post(wide.token, w.patientId, '/visits').expect(400)).body
          .message,
      ).toMatch(/sede/);
      const stranger = await actorIn(ctx, fx, 'DENTIST', {
        clinicId: w.clinic.id,
        branchId: w.branchA.id,
      });
      expect(
        (await post(stranger.token, w.patientId, '/visits').expect(403)).body
          .code,
      ).toBe('NO_CARE_RELATIONSHIP');
      for (const t of [
        w.reception.token,
        w.cashier.token,
        w.admin.token,
        w.assistant.token,
        w.director.token,
      ])
        await post(t, w.patientId, '/visits').expect(403);
      await ctx
        .http()
        .post(`/v1/patients/${w.patientId}/deactivate`)
        .set(bearer(w.reception.token))
        .send({ reason: 'Baja administrativa' })
        .expect(200);
      await post(w.dentist.token, w.patientId, '/visits').expect(409);
    });

    it('cerrar y cancelar: máquina de estados con versión optimista; no se cierra con procedimientos abiertos ni se cancela con vigentes', async () => {
      const w = await world();
      const def = await mkDef(w);
      const v = await openVisit(w);
      const p = await mkProc(w, v.id, def.id);
      await post(w.dentist.token, w.patientId, `/visits/${v.id}/close`, {
        expectedVersion: 9,
      }).expect(409);
      const open = await post(
        w.dentist.token,
        w.patientId,
        `/visits/${v.id}/close`,
        { expectedVersion: 1 },
      ).expect(409);
      expect(open.body).toMatchObject({ code: 'OPEN_PROCEDURES', count: 1 });
      await post(w.dentist.token, w.patientId, `/visits/${v.id}/cancel`, {
        expectedVersion: 1,
      }).expect(400); // falta el motivo
      expect(
        (
          await post(w.dentist.token, w.patientId, `/visits/${v.id}/cancel`, {
            expectedVersion: 1,
            reason: 'Se equivocó de paciente',
          }).expect(409)
        ).body.code,
      ).toBe('HAS_PROCEDURES');
      await post(w.dentist.token, w.patientId, `/procedures/${p.id}/cancel`, {
        expectedVersion: 1,
        reason: 'No se realizó',
      }).expect(200);
      const closed = expectStatus(
        await post(w.dentist.token, w.patientId, `/visits/${v.id}/close`, {
          expectedVersion: 1,
        }),
        200,
      );
      expect(closed.body).toMatchObject({ status: 'CLOSED', version: 2 });
      expect(closed.body.closedAt).toBeTruthy();
      await post(w.dentist.token, w.patientId, `/visits/${v.id}/close`, {
        expectedVersion: 2,
      }).expect(409);
      await post(w.dentist.token, w.patientId, `/visits/${v.id}/cancel`, {
        expectedVersion: 2,
        reason: 'Tarde',
      }).expect(409);

      const v2 = await openVisit(w);
      const x = expectStatus(
        await post(w.dentist.token, w.patientId, `/visits/${v2.id}/cancel`, {
          expectedVersion: 1,
          reason: 'El paciente no asistió',
        }),
        200,
      );
      expect(x.body).toMatchObject({
        status: 'CANCELLED',
        cancelReason: 'El paciente no asistió',
        version: 2,
      });
      const detail = (
        await get(w.dentist.token, w.patientId, `/visits/${v.id}`).expect(200)
      ).body;
      expect(detail.counts).toEqual({ diagnoses: 0, procedures: 1 });
      expect(
        (
          await get(
            w.dentist.token,
            w.patientId,
            '/visits?status=CLOSED',
          ).expect(200)
        ).body,
      ).toHaveLength(1);
    });

    it('en una visita cerrada o cancelada no se registran elementos nuevos; la base de datos lo impone y el núcleo es inmutable', async () => {
      const w = await world();
      const def = await mkDef(w);
      const v = await openVisit(w);
      await post(w.dentist.token, w.patientId, `/visits/${v.id}/close`, {
        expectedVersion: 1,
      }).expect(200);
      expect(
        (
          await post(
            w.dentist.token,
            w.patientId,
            `/visits/${v.id}/diagnoses`,
            { description: 'Tarde', certainty: 'PRESUMPTIVE' },
          ).expect(409)
        ).body.code,
      ).toBe('INVALID_STATE');
      await post(w.dentist.token, w.patientId, `/visits/${v.id}/procedures`, {
        definitionId: def.id,
      }).expect(409);
      const sql = (t: string, ...a: unknown[]) =>
        ctx.db.$executeRawUnsafe(t, ...a);
      await expect(
        sql('DELETE FROM clinical_visits WHERE id = ?', v.id),
      ).rejects.toThrow(/no se eliminan/);
      await expect(
        sql("UPDATE clinical_visits SET reason = 'otra' WHERE id = ?", v.id),
      ).rejects.toThrow(/inmutables/);
      await expect(
        sql("UPDATE clinical_visits SET status = 'OPEN' WHERE id = ?", v.id),
      ).rejects.toThrow(/inmutables|cerrada/);
      await expect(
        sql(
          'UPDATE clinical_visits SET dentist_user_id = ? WHERE id = ?',
          w.admin.user.id,
          v.id,
        ),
      ).rejects.toThrow(/inmutables/);
      // un elemento nuevo insertado directamente en una visita cerrada
      const itemId = crypto.randomUUID();
      await expect(
        ctx.db.clinicalDiagnosis.create({
          data: {
            clinicId: w.clinic.id,
            patientId: w.patientId,
            visitId: v.id,
            itemId,
            version: 1,
            currentKey: itemId,
            description: 'xx',
            certainty: 'PRESUMPTIVE',
            changeKind: 'CREATED',
            createdById: w.dentist.user.id,
          },
        }),
      ).rejects.toThrow(/visita abierta/);
      // FK compuesta: una visita de otra clínica/paciente no se puede enlazar
      const p2 = (await createPatient(ctx, w.reception.token)).id;
      const itemId2 = crypto.randomUUID();
      await expect(
        ctx.db.clinicalDiagnosis.create({
          data: {
            clinicId: w.clinic.id,
            patientId: p2,
            visitId: v.id,
            itemId: itemId2,
            version: 1,
            currentKey: itemId2,
            description: 'xx',
            certainty: 'PRESUMPTIVE',
            changeKind: 'CREATED',
            createdById: w.dentist.user.id,
          },
        }),
      ).rejects.toThrow();
    });

    it('solo el odontólogo responsable y en la sede de la visita registra o cierra; otro colega con relación, no', async () => {
      const w = await world();
      const v = await openVisit(w);
      const colleague = await fx.userWithRole('DENTIST', {
        clinicId: w.clinic.id,
      });
      await assignCare(ctx, w.reception.token, w.patientId, colleague.user.id);
      const colleagueToken = await loginInContext(ctx, colleague.user.email, {
        clinicId: w.clinic.id,
        branchId: w.branchA.id,
      }).catch(() =>
        loginInContext(ctx, colleague.user.email, { clinicId: w.clinic.id }),
      );
      const denied = await post(
        colleagueToken,
        w.patientId,
        `/visits/${v.id}/diagnoses`,
        { description: 'Ajeno', certainty: 'PRESUMPTIVE' },
      ).expect(403);
      expect(denied.body.code).toBe('NOT_VISIT_RESPONSIBLE');
      await post(colleagueToken, w.patientId, `/visits/${v.id}/close`, {
        expectedVersion: 1,
      }).expect(403);
      // pero lee (tiene relación)
      await get(colleagueToken, w.patientId, `/visits/${v.id}`).expect(200);
      // el responsable, desde otra sede, no escribe
      const wrong = await post(
        w.dentist.tokenB,
        w.patientId,
        `/visits/${v.id}/diagnoses`,
        { description: 'Otra sede', certainty: 'PRESUMPTIVE' },
      ).expect(403);
      expect(wrong.body.code).toBe('WRONG_BRANCH');
      await post(w.dentist.tokenB, w.patientId, `/visits/${v.id}/close`, {
        expectedVersion: 1,
      }).expect(403);
      const reasons = (
        await ctx.db.auditLog.findMany({
          where: { action: 'CLINICAL_ACCESS_DENIED', patientId: w.patientId },
        })
      ).map((l) => (l.summary as { reason: string }).reason);
      expect(reasons).toEqual(
        expect.arrayContaining(['not_visit_responsible', 'wrong_branch']),
      );
      // lee desde otra sede (continuidad)
      await get(w.dentist.tokenB, w.patientId, `/visits/${v.id}`).expect(200);
    });
  });

  describe('diagnósticos versionados', () => {
    it('se registran sin depender del consentimiento; corrección, rectificación, desactivación y error conservan todas las versiones', async () => {
      const w = await world();
      const v = await openVisit(w);
      const dx = await mkDiag(w, v.id, {
        description: 'Caries oclusal declarada',
        code: 'X-1',
      });
      expect(
        await ctx.db.patientConsent.count({
          where: { patientId: w.patientId },
        }),
      ).toBe(0); // sin consentimiento y aun así se registró
      const t = (path: string, b: object) =>
        post(w.dentist.token, w.patientId, `/diagnoses/${dx.id}${path}`, b);
      expectStatus(
        await t('/correct', {
          expectedVersion: 1,
          reason: 'Error de digitación',
          description: 'Caries oclusal declarada (corregida)',
        }),
        200,
      );
      expectStatus(
        await t('/rectify', {
          expectedVersion: 2,
          reason: 'Se confirmó con el estudio',
          certainty: 'DEFINITIVE',
          code: null,
        }),
        200,
      );
      await t('/deactivate', { expectedVersion: 3, reason: 'Resuelto' }).expect(
        200,
      );
      await t('/reactivate', {
        expectedVersion: 4,
        reason: 'Reapareció',
      }).expect(200);
      await t('/mark-error', {
        expectedVersion: 5,
        reason: 'Paciente equivocado',
      }).expect(200);
      const rows = await chain('clinicalDiagnosis', dx.id);
      expect(rows.map((r) => r.changeKind)).toEqual([
        'CREATED',
        'CORRECTED',
        'RECTIFIED',
        'DEACTIVATED',
        'REACTIVATED',
        'MARKED_IN_ERROR',
      ]);
      expect(rows.filter((r) => r.currentKey)).toHaveLength(1);
      const versions = (
        await get(
          w.dentist.token,
          w.patientId,
          `/diagnoses/${dx.id}/versions`,
        ).expect(200)
      ).body;
      expect(versions.map((x: { version: number }) => x.version)).toEqual([
        6, 5, 4, 3, 2, 1,
      ]);
      expect(versions.at(-1).description).toBe('Caries oclusal declarada'); // la original sigue intacta
      expect(
        versions
          .find((x: { version: number }) => x.version === 3)
          .changedFields.sort((a: string, b: string) => a.localeCompare(b)),
      ).toEqual(['certainty', 'code']);
      expect(
        (await get(w.dentist.token, w.patientId, '/diagnoses').expect(200))
          .body,
      ).toEqual([]);
      expect(
        (
          await get(
            w.dentist.token,
            w.patientId,
            '/diagnoses?status=ENTERED_IN_ERROR',
          ).expect(200)
        ).body,
      ).toHaveLength(1);
      const actions = (
        await ctx.db.auditLog.findMany({
          where: { entityId: dx.id },
          orderBy: { createdAt: 'asc' },
        })
      ).map((l) => l.action);
      expect(actions).toEqual([
        'CLINICAL_DIAGNOSIS_CREATED',
        'CLINICAL_DIAGNOSIS_CORRECTED',
        'CLINICAL_DIAGNOSIS_RECTIFIED',
        'CLINICAL_DIAGNOSIS_DEACTIVATED',
        'CLINICAL_DIAGNOSIS_REACTIVATED',
        'CLINICAL_DIAGNOSIS_MARKED_IN_ERROR',
      ]);
    });

    it('el alta no exige motivo; todo cambio posterior sí; versión obsoleta = 409; estados inválidos y cambios vacíos se rechazan', async () => {
      const w = await world();
      const v = await openVisit(w);
      const dx = await mkDiag(w, v.id);
      const t = (path: string, b: object) =>
        post(w.dentist.token, w.patientId, `/diagnoses/${dx.id}${path}`, b);
      await t('/correct', { expectedVersion: 1, description: 'Nuevo' }).expect(
        400,
      ); // sin motivo
      await t('/deactivate', { expectedVersion: 1 }).expect(400);
      await t('/correct', { expectedVersion: 1, reason: 'Sin cambios' }).expect(
        400,
      );
      await t('/correct', {
        expectedVersion: 1,
        reason: 'Mismo valor',
        description: dx.description,
      }).expect(400);
      const stale = await t('/correct', {
        expectedVersion: 4,
        reason: 'Versión vieja',
        description: 'Otra',
      }).expect(409);
      expect(stale.body).toMatchObject({
        code: 'VERSION_CONFLICT',
        currentVersion: 1,
      });
      expect(JSON.stringify(stale.body)).not.toContain(dx.description);
      await t('/reactivate', {
        expectedVersion: 1,
        reason: 'No estaba inactivo',
      }).expect(409);
      await t('/mark-error', {
        expectedVersion: 1,
        reason: 'Registrado por error',
      }).expect(200);
      await t('/correct', {
        expectedVersion: 2,
        reason: 'Tarde',
        description: 'XX',
      }).expect(409);
      expect(await chain('clinicalDiagnosis', dx.id)).toHaveLength(2);
      await post(w.dentist.token, w.patientId, `/visits/${v.id}/diagnoses`, {
        description: 'a',
        certainty: 'PRESUMPTIVE',
      }).expect(400);
      await post(w.dentist.token, w.patientId, `/visits/${v.id}/diagnoses`, {
        description: 'Válido',
        certainty: 'TAL_VEZ',
      }).expect(400);
      await post(w.dentist.token, w.patientId, `/visits/${v.id}/diagnoses`, {
        description: 'Válido',
        certainty: 'DEFINITIVE',
        reason: 'ab',
      }).expect(400);
    });

    it('la base de datos impide borrar, reescribir y encadenar mal las versiones', async () => {
      const w = await world();
      const v = await openVisit(w);
      const dx = await mkDiag(w, v.id);
      await post(w.dentist.token, w.patientId, `/diagnoses/${dx.id}/correct`, {
        expectedVersion: 1,
        reason: 'Corrección',
        description: 'Nueva',
      }).expect(200);
      const [v1, v2] = await ctx.db.clinicalDiagnosis.findMany({
        where: { itemId: dx.id },
        orderBy: { version: 'asc' },
      });
      const sql = (t: string, ...a: unknown[]) =>
        ctx.db.$executeRawUnsafe(t, ...a);
      await expect(
        sql('DELETE FROM clinical_diagnoses WHERE id = ?', v1!.id),
      ).rejects.toThrow(/no se eliminan/);
      await expect(
        sql(
          "UPDATE clinical_diagnoses SET description = 'Reescrito' WHERE id = ?",
          v1!.id,
        ),
      ).rejects.toThrow(/inmutable/);
      await expect(
        sql(
          'UPDATE clinical_diagnoses SET current_key = item_id WHERE id = ?',
          v1!.id,
        ),
      ).rejects.toThrow(/inmutable/);
      const row = {
        clinicId: w.clinic.id,
        patientId: w.patientId,
        visitId: v.id,
        itemId: dx.id,
        certainty: 'PRESUMPTIVE' as const,
        description: 'xx',
        createdById: w.dentist.user.id,
      };
      await ctx.db.clinicalDiagnosis.update({
        where: { id: v2!.id },
        data: { currentKey: null },
      });
      await expect(
        ctx.db.clinicalDiagnosis.create({
          data: {
            ...row,
            version: 3,
            supersedesId: v2!.id,
            currentKey: dx.id,
            changeKind: 'CORRECTED',
          },
        }),
      ).rejects.toThrow(/motivo/);
      await expect(
        ctx.db.clinicalDiagnosis.create({
          data: {
            ...row,
            version: 5,
            supersedesId: v2!.id,
            currentKey: dx.id,
            changeKind: 'CORRECTED',
            changeReason: 'Motivo válido',
          },
        }),
      ).rejects.toThrow(/continuar/);
      await expect(
        ctx.db.clinicalDiagnosis.create({
          data: {
            ...row,
            version: 1,
            currentKey: dx.id,
            changeKind: 'CORRECTED',
            changeReason: 'Motivo válido',
          },
        }),
      ).rejects.toThrow();
    });
  });

  describe('procedimientos y consentimiento', () => {
    it('procedimiento no obligatorio: se cierra sin consentimiento (NOT_REQUIRED)', async () => {
      const w = await world();
      const def = await mkDef(w, { requiresClinicalConsent: false });
      const v = await openVisit(w);
      const p = await mkProc(w, v.id, def.id);
      const closed = expectStatus(
        await post(w.dentist.token, w.patientId, `/procedures/${p.id}/close`, {
          expectedVersion: 1,
        }),
        200,
      ).body;
      expect(closed).toMatchObject({
        status: 'CLOSED',
        version: 2,
        closureConsent: 'NOT_REQUIRED',
        definition: { code: def.code, name: def.name },
        responsibleUserId: w.dentist.user.id,
      });
      expect(closed.closedAt).toBeTruthy();
      const log = await ctx.db.auditLog.findFirstOrThrow({
        where: { entityId: p.id, action: 'CLINICAL_PROCEDURE_CLOSED' },
      });
      expect(log.summary).toMatchObject({
        definitionId: def.id,
        version: 2,
        consentVerified: 'NOT_REQUIRED',
      });
    });

    it('procedimiento obligatorio: sin consentimiento NO se cierra (409, auditado sin contenido); abrirlo y planificarlo sí; con consentimiento vigente se cierra', async () => {
      const w = await world();
      const def = await mkDef(w, { requiresClinicalConsent: true });
      const v = await openVisit(w); // abrir la visita no se bloquea
      const dx = await mkDiag(w, v.id); // diagnosticar tampoco
      const p = await mkProc(w, v.id, def.id, {
        notes: 'NOTAS-CLINICAS-NO-AUDITAR',
      }); // registrar/abrir tampoco
      await post(w.dentist.token, w.patientId, `/procedures/${p.id}/correct`, {
        expectedVersion: 1,
        reason: 'Ajuste de notas',
        notes: 'otras notas',
      }).expect(200); // ni corregir

      const blocked = await post(
        w.dentist.token,
        w.patientId,
        `/procedures/${p.id}/close`,
        { expectedVersion: 2 },
      ).expect(409);
      expect(blocked.body).toMatchObject({
        code: 'CLINICAL_CONSENT_REQUIRED',
        consentState: 'MISSING',
      });
      expect(JSON.stringify(blocked.body)).not.toMatch(/NOTAS|otras notas/);
      expect(
        (
          await get(w.dentist.token, w.patientId, `/procedures/${p.id}`).expect(
            200,
          )
        ).body,
      ).toMatchObject({ status: 'OPEN', version: 2 });
      const audit = await ctx.db.auditLog.findFirstOrThrow({
        where: { entityId: p.id, action: 'CLINICAL_PROCEDURE_CLOSE_BLOCKED' },
      });
      expect(audit).toMatchObject({
        userId: w.dentist.user.id,
        patientId: w.patientId,
        clinicId: w.clinic.id,
      });
      expect(audit.summary).toEqual({
        itemId: p.id,
        visitId: v.id,
        definitionId: def.id,
        version: 2,
        reason: 'consent_missing',
      });
      expect(JSON.stringify(audit)).not.toMatch(
        /NOTAS|otras notas|Diagnostico-|Procedimiento /,
      );

      await grantConsent(w);
      const closed = expectStatus(
        await post(w.dentist.token, w.patientId, `/procedures/${p.id}/close`, {
          expectedVersion: 2,
        }),
        200,
      ).body;
      expect(closed).toMatchObject({
        status: 'CLOSED',
        closureConsent: 'GRANTED',
        version: 3,
      });
      expect(dx.id).toBeTruthy();
    });

    it('consentimiento revocado: bloquea con causa consent_revoked; un consentimiento de otro tipo no sirve; cancelar nunca se bloquea', async () => {
      const w = await world();
      const def = await mkDef(w, { requiresClinicalConsent: true });
      const v = await openVisit(w);
      const p = await mkProc(w, v.id, def.id);
      const q = await mkProc(w, v.id, def.id);
      const consent = (await grantConsent(w)).body;
      await ctx
        .http()
        .post(`/v1/patients/${w.patientId}/consents/${consent.id}/revoke`)
        .set(bearer(w.reception.token))
        .send({ reason: 'El paciente lo retiró' })
        .expect(200);
      const blocked = await post(
        w.dentist.token,
        w.patientId,
        `/procedures/${p.id}/close`,
        { expectedVersion: 1 },
      ).expect(409);
      expect(blocked.body).toMatchObject({
        code: 'CLINICAL_CONSENT_REQUIRED',
        consentState: 'REVOKED',
      });
      expect(
        (
          await ctx.db.auditLog.findFirstOrThrow({
            where: {
              entityId: p.id,
              action: 'CLINICAL_PROCEDURE_CLOSE_BLOCKED',
            },
          })
        ).summary,
      ).toMatchObject({ reason: 'consent_revoked' });
      // un consentimiento de marketing no es el clínico
      await ctx
        .http()
        .post(`/v1/patients/${w.patientId}/consents`)
        .set(bearer(w.reception.token))
        .send(
          clinicalConsentBody({
            type: 'MARKETING',
            documentTitle: 'Marketing',
          }),
        )
        .expect(201);
      await post(w.dentist.token, w.patientId, `/procedures/${p.id}/close`, {
        expectedVersion: 1,
      }).expect(409);
      // cancelar y marcar por error no dependen del consentimiento
      await post(w.dentist.token, w.patientId, `/procedures/${p.id}/cancel`, {
        expectedVersion: 1,
        reason: 'Sin consentimiento',
      }).expect(200);
      await post(
        w.dentist.token,
        w.patientId,
        `/procedures/${q.id}/mark-error`,
        { expectedVersion: 1, reason: 'Registrado por error' },
      ).expect(200);
      // un nuevo consentimiento vigente permite cerrar el siguiente
      await grantConsent(w);
      const r = await mkProc(w, v.id, def.id);
      await post(w.dentist.token, w.patientId, `/procedures/${r.id}/close`, {
        expectedVersion: 1,
      }).expect(200);
    });

    it('la política se evalúa al cerrar con la configuración vigente: cambiar el catálogo afecta a los abiertos, no a los cerrados; el consentimiento de OTRO paciente no cuenta', async () => {
      const w = await world();
      const def = await mkDef(w, { requiresClinicalConsent: false });
      const v = await openVisit(w);
      const p = await mkProc(w, v.id, def.id);
      const done = await mkProc(w, v.id, def.id);
      await post(w.dentist.token, w.patientId, `/procedures/${done.id}/close`, {
        expectedVersion: 1,
      }).expect(200);
      await ctx
        .http()
        .patch(`/v1/procedure-definitions/${def.id}`)
        .set(bearer(w.admin.token))
        .send({
          expectedVersion: 1,
          reason: 'Ahora lo exige la clínica',
          requiresClinicalConsent: true,
        })
        .expect(200);
      await post(w.dentist.token, w.patientId, `/procedures/${p.id}/close`, {
        expectedVersion: 1,
      }).expect(409); // abierto: aplica la nueva política
      expect(
        (
          await get(
            w.dentist.token,
            w.patientId,
            `/procedures/${done.id}`,
          ).expect(200)
        ).body,
      ).toMatchObject({ status: 'CLOSED', closureConsent: 'NOT_REQUIRED' }); // cerrado: intacto
      const other = (await createPatient(ctx, w.reception.token)).id;
      await grantConsent(w, other);
      await post(w.dentist.token, w.patientId, `/procedures/${p.id}/close`, {
        expectedVersion: 1,
      }).expect(409);
    });

    it('la base de datos también impone el consentimiento al cerrar', async () => {
      const w = await world();
      const def = await mkDef(w, { requiresClinicalConsent: true });
      const v = await openVisit(w);
      const p = await mkProc(w, v.id, def.id);
      const [v1] = await ctx.db.clinicalProcedure.findMany({
        where: { itemId: p.id },
      });
      await ctx.db.clinicalProcedure.update({
        where: { id: v1!.id },
        data: { currentKey: null },
      });
      const closeRow = {
        clinicId: v1!.clinicId,
        patientId: v1!.patientId,
        visitId: v1!.visitId,
        itemId: v1!.itemId,
        definitionId: v1!.definitionId,
        definitionCode: v1!.definitionCode,
        definitionName: v1!.definitionName,
        dentistUserId: v1!.dentistUserId,
        performedAt: v1!.performedAt,
        createdById: v1!.createdById,
        id: crypto.randomUUID(),
        version: 2,
        supersedesId: v1!.id,
        currentKey: p.id,
        status: 'CLOSED' as const,
        closedAt: new Date(),
        closureConsent: 'NOT_REQUIRED' as const,
        changeKind: 'CLOSED' as const,
        changeReason: null,
      };
      await expect(
        ctx.db.clinicalProcedure.create({ data: closeRow }),
      ).rejects.toThrow(/requiere consentimiento clínico vigente/);
      await grantConsent(w);
      await expect(
        ctx.db.clinicalProcedure.create({ data: closeRow }),
      ).resolves.toBeTruthy();
    });

    it('el catálogo es de la clínica: una definición ajena o inexistente da 404 uniforme; una inactiva no admite registros nuevos; el historial conserva el nombre original', async () => {
      const w = await world();
      const v = await openVisit(w);
      const otherAdmin = await actorIn(ctx, fx, 'CLINIC_ADMIN', {
        clinicId: (await fx.clinic()).id,
      });
      const foreign = (
        await ctx
          .http()
          .post('/v1/procedure-definitions')
          .set(bearer(otherAdmin.token))
          .send(defBody())
          .expect(201)
      ).body;
      const a = await post(
        w.dentist.token,
        w.patientId,
        `/visits/${v.id}/procedures`,
        { definitionId: foreign.id },
      ).expect(404);
      const b = await post(
        w.dentist.token,
        w.patientId,
        `/visits/${v.id}/procedures`,
        { definitionId: GHOST },
      ).expect(404);
      expect(a.body.message).toBe(b.body.message);
      const def = await mkDef(w);
      const p = await mkProc(w, v.id, def.id);
      await ctx
        .http()
        .patch(`/v1/procedure-definitions/${def.id}`)
        .set(bearer(w.admin.token))
        .send({
          expectedVersion: 1,
          reason: 'Se renombra',
          name: 'Nombre nuevo',
        })
        .expect(200);
      await ctx
        .http()
        .post(`/v1/procedure-definitions/${def.id}/deactivate`)
        .set(bearer(w.admin.token))
        .send({ expectedVersion: 2, reason: 'Ya no se ofrece' })
        .expect(200);
      expect(
        (
          await post(
            w.dentist.token,
            w.patientId,
            `/visits/${v.id}/procedures`,
            { definitionId: def.id },
          ).expect(409)
        ).body.code,
      ).toBe('DEFINITION_INACTIVE');
      expect(
        (
          await get(w.dentist.token, w.patientId, `/procedures/${p.id}`).expect(
            200,
          )
        ).body.definition,
      ).toMatchObject({ code: def.code, name: def.name }); // copia original
      await post(w.dentist.token, w.patientId, `/procedures/${p.id}/close`, {
        expectedVersion: 1,
      }).expect(200); // el abierto sigue pudiendo cerrarse
    });

    it('procedimientos: versiones inmutables, correcciones con motivo, estados y fechas válidas', async () => {
      const w = await world();
      const def = await mkDef(w);
      const v = await openVisit(w);
      const p = await mkProc(w, v.id, def.id, { notes: 'Notas iniciales' });
      const t = (path: string, b: object) =>
        post(w.dentist.token, w.patientId, `/procedures/${p.id}${path}`, b);
      await t('/correct', { expectedVersion: 1, notes: 'x' }).expect(400); // sin motivo
      await t('/correct', { expectedVersion: 1, reason: 'Sin cambios' }).expect(
        400,
      );
      await t('/correct', {
        expectedVersion: 1,
        reason: 'Fecha futura',
        performedAt: '2999-01-01T00:00:00Z',
      }).expect(400);
      await t('/correct', {
        expectedVersion: 5,
        reason: 'Versión vieja',
        notes: 'otra',
      }).expect(409);
      await t('/rectify', {
        expectedVersion: 1,
        reason: 'Se amplían las notas',
        notes: 'Notas ampliadas',
      }).expect(200);
      await t('/close', { expectedVersion: 2 }).expect(200);
      await t('/close', { expectedVersion: 3 }).expect(409); // ya cerrado
      await t('/correct', {
        expectedVersion: 3,
        reason: 'Corrección posterior al cierre',
        notes: 'Notas corregidas',
      }).expect(200); // versionada
      await t('/cancel', { expectedVersion: 4, reason: 'Ya cerrado' }).expect(
        409,
      );
      await t('/mark-error', {
        expectedVersion: 4,
        reason: 'Registrado por error',
      }).expect(200);
      await t('/correct', {
        expectedVersion: 5,
        reason: 'Tarde',
        notes: 'z',
      }).expect(409);
      const rows = await chain('clinicalProcedure', p.id);
      expect(rows.map((r) => [r.version, r.changeKind, r.status])).toEqual([
        [1, 'CREATED', 'OPEN'],
        [2, 'RECTIFIED', 'OPEN'],
        [3, 'CLOSED', 'CLOSED'],
        [4, 'CORRECTED', 'CLOSED'],
        [5, 'MARKED_IN_ERROR', 'ENTERED_IN_ERROR'],
      ]);
      expect(rows.filter((r) => r.currentKey)).toHaveLength(1);
      const sql = (q: string, ...a: unknown[]) =>
        ctx.db.$executeRawUnsafe(q, ...a);
      const first = await ctx.db.clinicalProcedure.findFirstOrThrow({
        where: { itemId: p.id, version: 1 },
      });
      await expect(
        sql('DELETE FROM clinical_procedures WHERE id = ?', first.id),
      ).rejects.toThrow(/no se eliminan/);
      await expect(
        sql(
          "UPDATE clinical_procedures SET notes = 'Reescrito' WHERE id = ?",
          first.id,
        ),
      ).rejects.toThrow(/inmutable/);
      expect(
        (
          await get(
            w.dentist.token,
            w.patientId,
            `/procedures/${p.id}/versions`,
          ).expect(200)
        ).body,
      ).toHaveLength(5);
    });
  });

  describe('quién accede', () => {
    it('el asistente no ve diagnósticos ni procedimientos ni visitas (vista de apoyo = solo alertas); tampoco escribe', async () => {
      const w = await world();
      const def = await mkDef(w);
      const v = await openVisit(w);
      const dx = await mkDiag(w, v.id);
      const p = await mkProc(w, v.id, def.id);
      for (const path of [
        '/visits',
        `/visits/${v.id}`,
        '/diagnoses',
        `/diagnoses/${dx.id}`,
        `/diagnoses/${dx.id}/versions`,
        '/procedures',
        `/procedures/${p.id}`,
        `/procedures/${p.id}/versions`,
      ]) {
        expect(
          (await get(w.assistant.token, w.patientId, path).expect(403)).body
            .code,
        ).toBe('CLINICAL_LIMITED_VIEW');
      }
      await post(w.assistant.token, w.patientId, `/visits/${v.id}/diagnoses`, {
        description: 'xx',
        certainty: 'PRESUMPTIVE',
      }).expect(403);
      await post(w.assistant.token, w.patientId, `/procedures/${p.id}/close`, {
        expectedVersion: 1,
      }).expect(403);
      expect(
        JSON.stringify(
          (await get(w.assistant.token, w.patientId, '/alerts').expect(200))
            .body,
        ),
      ).not.toMatch(/Diagnostico-|NOTAS-/);
      const summary = (
        await ctx
          .http()
          .get(`/v1/patients/${w.patientId}/clinical-summary`)
          .set(bearer(w.assistant.token))
          .expect(200)
      ).body;
      expect(JSON.stringify(summary)).not.toMatch(/Diagnostico-|NOTAS-|visit/i);
    });

    it('Director: sin autorización no lee; con ella solo lee (nunca escribe ni cierra)', async () => {
      const w = await world();
      const def = await mkDef(w);
      const v = await openVisit(w);
      const dx = await mkDiag(w, v.id);
      const p = await mkProc(w, v.id, def.id);
      for (const path of [
        '/visits',
        `/visits/${v.id}`,
        '/diagnoses',
        `/diagnoses/${dx.id}/versions`,
        '/procedures',
      ]) {
        expect(
          (await get(w.director.token, w.patientId, path).expect(403)).body
            .code,
        ).toBe('CLINICAL_JUSTIFICATION_REQUIRED');
      }
      expectStatus(await grantReadAll(ctx, w.director.token, w.patientId), 201);
      expect(
        (await get(w.director.token, w.patientId, '/visits').expect(200)).body,
      ).toHaveLength(1);
      expect(
        (await get(w.director.token, w.patientId, '/diagnoses').expect(200))
          .body,
      ).toHaveLength(1);
      expect(
        (
          await get(
            w.director.token,
            w.patientId,
            `/procedures/${p.id}/versions`,
          ).expect(200)
        ).body,
      ).toHaveLength(1);
      await post(w.director.token, w.patientId, '/visits').expect(403);
      await post(w.director.token, w.patientId, `/visits/${v.id}/diagnoses`, {
        description: 'xx',
        certainty: 'PRESUMPTIVE',
      }).expect(403);
      await post(
        w.director.token,
        w.patientId,
        `/diagnoses/${dx.id}/mark-error`,
        { expectedVersion: 1, reason: 'No debe' },
      ).expect(403);
      await post(w.director.token, w.patientId, `/procedures/${p.id}/close`, {
        expectedVersion: 1,
      }).expect(403);
      expect(
        await ctx.db.auditLog.count({
          where: { patientId: w.patientId, action: 'CLINICAL_READ_ALL_READ' },
        }),
      ).toBe(3);
      expect(await chain('clinicalProcedure', p.id)).toHaveLength(1);
    });

    it('recepción solo lee (vista): 200 en lecturas, 404 si no existe, 403 en toda escritura', async () => {
      const w = await world();
      const v = await openVisit(w);
      for (const path of ['/visits', `/visits/${v.id}`, '/diagnoses', '/procedures'])
        await get(w.reception.token, w.patientId, path).expect(200);
      for (const path of ['/visits', '/diagnoses', '/procedures']) await get(w.reception.token, GHOST, path).expect(404);
      await post(w.reception.token, w.patientId, `/visits/${v.id}/diagnoses`, { description: 'xx', certainty: 'PRESUMPTIVE' }).expect(403);
      await post(w.reception.token, w.patientId, '/visits', { reason: 'Recepción no abre visitas' }).expect(403);
    });

    it('administración, caja y plataforma: 403 genérico idéntico exista o no el paciente', async () => {
      const w = await world();
      const v = await openVisit(w);
      const { user } = await fx.userWithRole('PLATFORM_ADMIN');
      const platform = await loginInContext(ctx, user.email);
      for (const t of [
        platform,
        w.cashier.token,
      ]) {
        for (const path of [
          '/visits',
          `/visits/${v.id}`,
          '/diagnoses',
          '/procedures',
        ]) {
          const real = await get(t, w.patientId, path).expect(403);
          const ghost = await get(t, GHOST, path).expect(403);
          expect(real.body.message).toBe(ghost.body.message);
        }
        await post(t, w.patientId, `/visits/${v.id}/diagnoses`, {
          description: 'xx',
          certainty: 'PRESUMPTIVE',
        }).expect(403);
      }
    });

    it('relación revocada o de otro odontólogo: ni lee ni escribe', async () => {
      const w = await world();
      const v = await openVisit(w);
      const dx = await mkDiag(w, v.id);
      const stranger = await actorIn(ctx, fx, 'DENTIST', {
        clinicId: w.clinic.id,
        branchId: w.branchA.id,
      });
      for (const path of ['/visits', '/diagnoses', '/procedures'])
        expect(
          (await get(stranger.token, w.patientId, path).expect(403)).body.code,
        ).toBe('NO_CARE_RELATIONSHIP');
      await revokeCareReq(ctx, w.reception.token, w.rel.id).expect(200);
      for (const path of [
        '/visits',
        `/visits/${v.id}`,
        '/diagnoses',
        `/diagnoses/${dx.id}/versions`,
      ])
        expect(
          (await get(w.dentist.token, w.patientId, path).expect(403)).body.code,
        ).toBe('NO_CARE_RELATIONSHIP');
      await post(w.dentist.token, w.patientId, `/diagnoses/${dx.id}/correct`, {
        expectedVersion: 1,
        reason: 'Tarde',
        description: 'xx',
      }).expect(403);
      await post(w.dentist.token, w.patientId, `/visits/${v.id}/close`, {
        expectedVersion: 1,
      }).expect(403);
      expect(await chain('clinicalDiagnosis', dx.id)).toHaveLength(1);
    });
  });

  describe('aislamiento entre clínicas', () => {
    it('otra clínica recibe 404 idéntico al de un id inexistente (visitas, diagnósticos, procedimientos, catálogo); nada se asocia al paciente ajeno', async () => {
      const w = await world();
      const def = await mkDef(w);
      const v = await openVisit(w);
      const dx = await mkDiag(w, v.id);
      const p = await mkProc(w, v.id, def.id);
      const other = await fx.clinic();
      const receptionB = await actorIn(ctx, fx, 'RECEPTIONIST', {
        clinicId: other.id,
      });
      const dentistB = await actorIn(ctx, fx, 'DENTIST', {
        clinicId: other.id,
        branchId: (await fx.branch(other.id)).id,
      });
      const { id: patientB } = await createPatient(ctx, receptionB.token);
      await assignCare(ctx, receptionB.token, patientB, dentistB.user.id);
      const vB = await openVisit(w, dentistB.token, patientB);

      const paths = [
        '/visits',
        `/visits/${v.id}`,
        '/diagnoses',
        `/diagnoses/${dx.id}`,
        `/diagnoses/${dx.id}/versions`,
        '/procedures',
        `/procedures/${p.id}`,
        `/procedures/${p.id}/versions`,
      ];
      for (const path of paths) {
        const foreign = await get(dentistB.token, w.patientId, path).expect(
          404,
        );
        const ghost = await get(dentistB.token, GHOST, path).expect(404);
        expect(foreign.body.message).toBe(ghost.body.message);
      }
      await post(dentistB.token, w.patientId, '/visits').expect(404);
      await post(dentistB.token, w.patientId, `/visits/${v.id}/diagnoses`, {
        description: 'xx',
        certainty: 'PRESUMPTIVE',
      }).expect(404);
      // ids de A usados con un paciente PROPIO de B: no existen para B y no se modifican
      for (const path of [
        `/visits/${v.id}`,
        `/diagnoses/${dx.id}`,
        `/procedures/${p.id}`,
      ])
        await get(dentistB.token, patientB, path).expect(404);
      await post(dentistB.token, patientB, `/visits/${v.id}/diagnoses`, {
        description: 'xx',
        certainty: 'PRESUMPTIVE',
      }).expect(404);
      await post(dentistB.token, patientB, `/visits/${v.id}/close`, {
        expectedVersion: 1,
      }).expect(404);
      await post(dentistB.token, patientB, `/diagnoses/${dx.id}/mark-error`, {
        expectedVersion: 1,
        reason: 'Ajeno',
      }).expect(404);
      await post(dentistB.token, patientB, `/procedures/${p.id}/close`, {
        expectedVersion: 1,
      }).expect(404);
      await post(dentistB.token, patientB, `/visits/${vB.id}/procedures`, {
        definitionId: def.id,
      }).expect(404); // catálogo ajeno
      expect(
        (await ctx.db.clinicalVisit.findUniqueOrThrow({ where: { id: v.id } }))
          .status,
      ).toBe('OPEN');
      expect(await chain('clinicalDiagnosis', dx.id)).toHaveLength(1);

      // enumeración: ids aleatorios, de otra clínica e inexistentes se ven igual
      const messages = new Set<string>();
      for (const id of [
        GHOST,
        w.patientId,
        ...Array.from({ length: 6 }, () => crypto.randomUUID()),
      ])
        messages.add(
          (await get(dentistB.token, id, '/visits').expect(404)).body.message,
        );
      expect(messages.size).toBe(1);
      for (const r of await ctx.db.auditLog.findMany({
        where: { userId: dentistB.user.id, action: 'CLINICAL_ACCESS_DENIED' },
      })) {
        expect(JSON.stringify(r)).not.toContain(w.patientId);
      }
    });
  });

  describe('contenido clínico fuera de las vías autorizadas', () => {
    it('ni la auditoría, ni los listados administrativos, ni los errores, ni los logs contienen diagnósticos, notas o motivos', async () => {
      const w = await world();
      const marker = uniq('CLINICO-');
      const def = await mkDef(w, { requiresClinicalConsent: true });
      const v = await openVisit(w, w.dentist.token, w.patientId, {
        reason: `${marker}-motivo-visita`,
      });
      const dx = await mkDiag(w, v.id, {
        description: `${marker}-diag`,
        code: `${marker}-cod`,
      });
      await post(w.dentist.token, w.patientId, `/diagnoses/${dx.id}/correct`, {
        expectedVersion: 1,
        reason: `${marker}-razon`,
        description: `${marker}-diag2`,
      }).expect(200);
      await post(w.dentist.token, w.patientId, `/diagnoses/${dx.id}/correct`, {
        expectedVersion: 1,
        reason: `${marker}-conflicto`,
        description: `${marker}-x`,
      }).expect(409);
      const p = await mkProc(w, v.id, def.id, { notes: `${marker}-notas` });
      await post(w.dentist.token, w.patientId, `/procedures/${p.id}/close`, {
        expectedVersion: 1,
      }).expect(409); // bloqueo por consentimiento
      await post(w.dentist.token, w.patientId, `/visits/${v.id}/diagnoses`, {
        description: `${marker}-corto`,
        certainty: 'NADA',
      }).expect(400);
      expectStatus(await grantReadAll(ctx, w.director.token, w.patientId), 201);
      await get(w.director.token, w.patientId, '/diagnoses').expect(200);

      const has = (x: unknown) => JSON.stringify(x).includes(marker);
      expect(has(await ctx.db.auditLog.findMany({}))).toBe(false);
      for (const q of [
        '',
        '?action=CLINICAL_PROCEDURE_CLOSE_BLOCKED',
        `?patientId=${w.patientId}&limit=100`,
      ]) {
        expect(
          (
            await ctx
              .http()
              .get(`/v1/audit-logs${q}`)
              .set(bearer(w.admin.token))
              .expect(200)
          ).text,
        ).not.toContain(marker);
      }
      const lastName = (
        await ctx.db.patient.findUniqueOrThrow({ where: { id: w.patientId } })
      ).lastName;
      const admin = [
        await ctx
          .http()
          .get(`/v1/patients?name=${marker}`)
          .set(bearer(w.reception.token)),
        await ctx
          .http()
          .get(`/v1/patients?name=${lastName}`)
          .set(bearer(w.dentist.token)),
        await ctx
          .http()
          .get(`/v1/patients/${w.patientId}`)
          .set(bearer(w.admin.token)),
        await ctx
          .http()
          .get(`/v1/patients/${w.patientId}/consents`)
          .set(bearer(w.dentist.token)),
        await ctx
          .http()
          .get(`/v1/care-relationships`)
          .set(bearer(w.admin.token)),
        await ctx
          .http()
          .get(`/v1/patients/${w.patientId}/care-relationships`)
          .set(bearer(w.admin.token)),
        await ctx
          .http()
          .get('/v1/procedure-definitions')
          .set(bearer(w.admin.token)),
        await get(w.assistant.token, w.patientId, '/alerts'),
        await ctx
          .http()
          .get(`/v1/patients/${w.patientId}/clinical-summary`)
          .set(bearer(w.assistant.token)),
        await get(w.dentist.token, GHOST, '/diagnoses'),
      ];
      for (const r of admin) expect(r.text).not.toContain(marker);
      expect(logger.lines.join('\n')).not.toContain(marker);
      expect(logger.lines.length).toBeGreaterThan(0);
    });

    it('si falla la auditoría de la lectura: 503 sin datos; si falla la de una escritura: se revierte todo', async () => {
      const w = await world();
      const v = await openVisit(w);
      const dx = await mkDiag(w, v.id);
      const audit = ctx.app.get(AuditService);
      const original = audit.record.bind(audit);
      vi.spyOn(audit, 'record').mockImplementation(async (entry, tx) => {
        if (entry.action === 'CLINICAL_RECORD_VIEWED')
          throw new Error('auditoría caída');
        if (
          entry.action.startsWith('CLINICAL_DIAGNOSIS_') ||
          entry.action.startsWith('CLINICAL_VISIT_')
        )
          throw new Error('auditoría caída');
        return original(entry, tx);
      });
      for (const path of [
        '/visits',
        '/diagnoses',
        `/diagnoses/${dx.id}/versions`,
        '/procedures',
      ]) {
        const res = await get(w.dentist.token, w.patientId, path).expect(503);
        expect(res.text).not.toContain(dx.description);
      }
      expect(
        (
          await post(
            w.dentist.token,
            w.patientId,
            `/visits/${v.id}/diagnoses`,
            { description: 'No debe quedar', certainty: 'PRESUMPTIVE' },
          )
        ).status,
      ).toBeGreaterThanOrEqual(500);
      expect(
        (
          await post(
            w.dentist.token,
            w.patientId,
            `/diagnoses/${dx.id}/correct`,
            {
              expectedVersion: 1,
              reason: 'No debe quedar',
              description: 'Cambio',
            },
          )
        ).status,
      ).toBeGreaterThanOrEqual(500);
      expect(
        (
          await post(w.dentist.token, w.patientId, `/visits/${v.id}/close`, {
            expectedVersion: 1,
          })
        ).status,
      ).toBeGreaterThanOrEqual(500);
      vi.restoreAllMocks();
      expect(
        await ctx.db.clinicalDiagnosis.count({
          where: { patientId: w.patientId },
        }),
      ).toBe(1);
      expect(
        (await ctx.db.clinicalVisit.findUniqueOrThrow({ where: { id: v.id } }))
          .status,
      ).toBe('OPEN');
      expect((await chain('clinicalDiagnosis', dx.id))[0]!.currentKey).toBe(
        dx.id,
      );
    });
  });

  describe('concurrencia', () => {
    it('correcciones simultáneas de un diagnóstico sobre la misma versión: una prospera y la cadena queda íntegra', async () => {
      const w = await world();
      const v = await openVisit(w);
      const dx = await mkDiag(w, v.id);
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          post(w.dentist.token, w.patientId, `/diagnoses/${dx.id}/correct`, {
            expectedVersion: 1,
            reason: 'Variante',
            description: `Variante ${i}`,
          }),
        ),
      );
      expect(results.map((r) => r.status).sort((x, y) => x - y)).toEqual([
        200, 409, 409, 409, 409,
      ]);
      const rows = await chain('clinicalDiagnosis', dx.id);
      expect(rows.map((r) => r.version)).toEqual([1, 2]);
      expect(rows.filter((r) => r.currentKey)).toHaveLength(1);
    });

    it('cerrar un procedimiento a la vez de dos formas, o cerrar y cancelar: una sola gana', async () => {
      const w = await world();
      const def = await mkDef(w);
      const v = await openVisit(w);
      const p = await mkProc(w, v.id, def.id);
      const [a, b, c] = await Promise.all([
        post(w.dentist.token, w.patientId, `/procedures/${p.id}/close`, {
          expectedVersion: 1,
        }),
        post(w.dentist.token, w.patientId, `/procedures/${p.id}/close`, {
          expectedVersion: 1,
        }),
        post(w.dentist.token, w.patientId, `/procedures/${p.id}/cancel`, {
          expectedVersion: 1,
          reason: 'Se cancela',
        }),
      ]);
      expect([a.status, b.status, c.status].sort((x, y) => x - y)).toEqual([
        200, 409, 409,
      ]);
      const rows = await chain('clinicalProcedure', p.id);
      expect(rows).toHaveLength(2);
      expect(rows.filter((r) => r.currentKey)).toHaveLength(1);
    });

    it('revocar el consentimiento mientras se cierra un procedimiento obligatorio: nunca se cierra sin consentimiento vigente', async () => {
      for (let round = 0; round < 6; round++) {
        const w = await world();
        const def = await mkDef(w, { requiresClinicalConsent: true });
        const v = await openVisit(w);
        const p = await mkProc(w, v.id, def.id);
        const consent = (await grantConsent(w)).body;
        const [closed, revoked] = await Promise.all([
          post(w.dentist.token, w.patientId, `/procedures/${p.id}/close`, {
            expectedVersion: 1,
          }),
          ctx
            .http()
            .post(`/v1/patients/${w.patientId}/consents/${consent.id}/revoke`)
            .set(bearer(w.reception.token))
            .send({ reason: 'El paciente lo retiró' }),
        ]);
        expect(revoked.status, `ronda ${round}`).toBe(200);
        expect([200, 409], `ronda ${round}`).toContain(closed.status);
        const rows = await chain('clinicalProcedure', p.id);
        if (closed.status === 200) {
          // se cerró ANTES de la revocación: el consentimiento estaba vigente en ese momento
          expect(rows.at(-1)!.status).toBe('CLOSED');
          expect(
            await ctx.db.auditLog.count({
              where: { entityId: p.id, action: 'CLINICAL_PROCEDURE_CLOSED' },
            }),
          ).toBe(1);
        } else {
          expect(rows.at(-1)!.status).toBe('OPEN');
          expect(
            await ctx.db.auditLog.count({
              where: {
                entityId: p.id,
                action: 'CLINICAL_PROCEDURE_CLOSE_BLOCKED',
              },
            }),
          ).toBe(1);
        }
      }
    });

    it('cerrar la visita mientras se registran elementos: nada queda dentro de una visita cerrada', async () => {
      for (let round = 0; round < 6; round++) {
        const w = await world();
        const v = await openVisit(w);
        const writes = Array.from({ length: 4 }, (_, i) =>
          post(w.dentist.token, w.patientId, `/visits/${v.id}/diagnoses`, {
            description: `Concurrente ${i}`,
            certainty: 'PRESUMPTIVE',
          }),
        );
        const [closed, ...results] = await Promise.all([
          post(w.dentist.token, w.patientId, `/visits/${v.id}/close`, {
            expectedVersion: 1,
          }),
          ...writes,
        ]);
        expect(closed.status, `ronda ${round}`).toBe(200);
        expect(
          results.every((r) => r.status === 201 || r.status === 409),
          `ronda ${round}`,
        ).toBe(true);
        const ok = results.filter((r) => r.status === 201).length;
        expect(
          await ctx.db.clinicalDiagnosis.count({ where: { visitId: v.id } }),
        ).toBe(ok);
        const visit = await ctx.db.clinicalVisit.findUniqueOrThrow({
          where: { id: v.id },
        });
        for (const d of await ctx.db.clinicalDiagnosis.findMany({
          where: { visitId: v.id },
        }))
          expect(d.createdAt.getTime()).toBeLessThanOrEqual(
            visit.closedAt!.getTime() + 1000,
          );
      }
    });

    it('cerrar la visita mientras se registra un procedimiento: nunca queda un procedimiento abierto en una visita cerrada', async () => {
      for (let round = 0; round < 6; round++) {
        const w = await world();
        const def = await mkDef(w);
        const v = await openVisit(w);
        const [closed, created] = await Promise.all([
          post(w.dentist.token, w.patientId, `/visits/${v.id}/close`, {
            expectedVersion: 1,
          }),
          post(w.dentist.token, w.patientId, `/visits/${v.id}/procedures`, {
            definitionId: def.id,
          }),
        ]);
        const open = await ctx.db.clinicalProcedure.count({
          where: { visitId: v.id, currentKey: { not: null }, status: 'OPEN' },
        });
        const status = (
          await ctx.db.clinicalVisit.findUniqueOrThrow({ where: { id: v.id } })
        ).status;
        expect([201, 409], `ronda ${round}`).toContain(created.status);
        if (closed.status === 200) expect(open, `ronda ${round}`).toBe(0);
        else {
          expect(closed.status).toBe(409);
          expect(status).toBe('OPEN');
          expect(created.status).toBe(201);
        }
      }
    });

    it('revocar la relación, retirar el rol o deshabilitar al odontólogo mientras escribe: nada se escribe tras la baja', async () => {
      for (let round = 0; round < 3; round++) {
        const w = await world();
        const v = await openVisit(w);
        const assignments = await ctx.db.userAssignment.findMany({
          where: { userId: w.dentist.user.id, status: 'ACTIVE' },
        });
        const off =
          round === 0
            ? revokeCareReq(ctx, w.reception.token, w.rel.id)
            : round === 1
              ? ctx
                  .http()
                  .post(`/v1/users/${w.dentist.user.id}/disable`)
                  .set(bearer(w.admin.token))
                  .send({ reason: 'Baja del personal' })
              : Promise.all(
                  assignments.map((a) =>
                    ctx
                      .http()
                      .patch(`/v1/assignments/${a.id}/revoke`)
                      .set(bearer(w.admin.token))
                      .send(),
                  ),
                );
        const writes = Array.from({ length: 5 }, (_, i) =>
          post(w.dentist.token, w.patientId, `/visits/${v.id}/diagnoses`, {
            description: `Escritura ${i}`,
            certainty: 'PRESUMPTIVE',
          }),
        );
        const [offRes, ...results] = await Promise.all([off, ...writes]);
        if (Array.isArray(offRes))
          expect(offRes.every((r) => r.status === 200)).toBe(true);
        else expect((offRes as { status: number }).status).toBe(200);
        expect(
          results.every((r) => [201, 401, 403].includes(r.status)),
          `ronda ${round}`,
        ).toBe(true);
        const ok = results.filter((r) => r.status === 201).length;
        expect(
          await ctx.db.clinicalDiagnosis.count({ where: { visitId: v.id } }),
          `ronda ${round}`,
        ).toBe(ok);
        expect(
          await ctx.db.auditLog.count({
            where: {
              patientId: w.patientId,
              action: 'CLINICAL_DIAGNOSIS_CREATED',
            },
          }),
        ).toBe(ok);
        const after = await post(
          w.dentist.token,
          w.patientId,
          `/visits/${v.id}/diagnoses`,
          { description: 'Después', certainty: 'PRESUMPTIVE' },
        );
        expect([401, 403]).toContain(after.status);
        expect(
          await ctx.db.patientCareRelationship.count({
            where: { dentistUserId: w.dentist.user.id, status: 'ACTIVE' },
          }),
        ).toBe(round === 0 ? 0 : round === 1 ? 0 : 0);
      }
    });

    it('abrir visitas simultáneas del mismo odontólogo y paciente: solo una; la numeración no se repite', async () => {
      const w = await world();
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          post(w.dentist.token, w.patientId, '/visits'),
        ),
      );
      expect(results.map((r) => r.status).sort((x, y) => x - y)).toEqual([
        201, 409, 409, 409, 409,
      ]);
      expect(
        await ctx.db.clinicalVisit.count({ where: { patientId: w.patientId } }),
      ).toBe(1);
    });

    it('cambios simultáneos del catálogo sobre la misma versión: uno prospera', async () => {
      const w = await world();
      const def = await mkDef(w);
      const results = await Promise.all(
        Array.from({ length: 4 }, (_, i) =>
          ctx
            .http()
            .patch(`/v1/procedure-definitions/${def.id}`)
            .set(bearer(w.admin.token))
            .send({
              expectedVersion: 1,
              reason: 'Cambio',
              name: `Nombre ${i}`,
            }),
        ),
      );
      expect(results.map((r) => r.status).sort((x, y) => x - y)).toEqual([
        200, 409, 409, 409,
      ]);
      expect(
        (
          await ctx.db.procedureDefinition.findUniqueOrThrow({
            where: { id: def.id },
          })
        ).version,
      ).toBe(2);
    });
  });
});
