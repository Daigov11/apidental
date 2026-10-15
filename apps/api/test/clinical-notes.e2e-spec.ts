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
  PASSWORD,
  reauthProofFor,
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

describe('Evoluciones narrativas (3.4)', () => {
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
    const visit = expectStatus(
      await ctx
        .http()
        .post(`/v1/patients/${patientId}/clinical/visits`)
        .set(bearer(dentist.token))
        .send({ reason: 'Control' }),
      201,
    ).body as { id: string; version: number };
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
      visit,
    };
  }
  type W = Awaited<ReturnType<typeof world>>;

  const base = (w: W) =>
    `/v1/patients/${w.patientId}/clinical/visits/${w.visit.id}`;
  const evo = (w: W) => `${base(w)}/evolution`;
  const put = (t: string, w: W, b: object) =>
    ctx.http().put(evo(w)).set(bearer(t)).send(b);
  const post = (t: string, w: W, p: string, b: object = {}) =>
    ctx
      .http()
      .post(`${evo(w)}${p}`)
      .set(bearer(t))
      .send(b);
  const getEvo = (t: string, w: W, p = '') =>
    ctx
      .http()
      .get(`${evo(w)}${p}`)
      .set(bearer(t));
  const draft = async (
    w: W,
    body = uniq('TEXTO-'),
    over: Record<string, unknown> = {},
  ) =>
    expectStatus(await put(w.dentist.token, w, { body, ...over }), 201).body
      .evolution as { id: string; etag: string; body: string };
  const closed = async (w: W, body?: string) => {
    const d = await draft(w, body);
    return expectStatus(
      await post(w.dentist.token, w, '/close', {
        expectedEtag: d.etag,
        password: PASSWORD,
      }),
      200,
    ).body.evolution as { id: string; etag: string; body: string };
  };
  const rowsOf = (itemId: string) =>
    ctx.db.clinicalNote.findMany({
      where: { itemId },
      orderBy: { version: 'asc' },
    });
  const auditOf = (itemId: string) =>
    ctx.db.auditLog.findMany({
      where: { entityId: itemId },
      orderBy: { createdAt: 'asc' },
    });

  describe('borrador', () => {
    it('se crea (201) y se actualiza en el sitio (200) con etag; guardar lo mismo no cambia nada; no se pisan cambios', async () => {
      const w = await world();
      const first = await put(w.dentist.token, w, {
        body: 'Primer texto',
        followUp: 'Seguimiento inicial',
      });
      expect(first.status).toBe(201);
      expect(first.body.evolution).toMatchObject({
        version: 1,
        revision: 0,
        etag: '1.0',
        state: 'DRAFT',
        stateLabel: 'Borrador',
        body: 'Primer texto',
        closure: null,
        contentHidden: false,
      });
      const second = expectStatus(
        await put(w.dentist.token, w, {
          body: 'Texto ampliado',
          followUp: 'Seguimiento inicial',
          expectedEtag: '1.0',
        }),
        200,
      );
      expect(second.body.evolution).toMatchObject({
        version: 1,
        revision: 1,
        etag: '1.1',
        body: 'Texto ampliado',
      });
      // guardar exactamente lo mismo: sin nueva revisión
      const same = expectStatus(
        await put(w.dentist.token, w, {
          body: 'Texto ampliado',
          followUp: 'Seguimiento inicial',
          expectedEtag: '1.1',
        }),
        200,
      );
      expect(same.body.evolution.etag).toBe('1.1');
      const stale = await put(w.dentist.token, w, {
        body: 'Otro',
        expectedEtag: '1.0',
      }).expect(409);
      expect(stale.body).toMatchObject({
        code: 'VERSION_CONFLICT',
        currentEtag: '1.1',
      });
      expect(JSON.stringify(stale.body)).not.toContain('Texto ampliado');
      await put(w.dentist.token, w, { body: 'Sin etag' }).expect(409); // ya existe: hay que indicar la versión que se leyó
      expect(await rowsOf(first.body.evolution.id)).toHaveLength(1); // se edita en el sitio: una sola fila
      const actions = (await auditOf(first.body.evolution.id)).map(
        (l) => l.action,
      );
      expect(actions).toEqual([
        'CLINICAL_NOTE_CREATED',
        'CLINICAL_NOTE_DRAFT_SAVED',
      ]); // el guardado idéntico no se audita de nuevo
    });

    it('validaciones: texto obligatorio y acotado, etag bien formado, campos desconocidos', async () => {
      const w = await world();
      for (const b of [
        {},
        { body: '' },
        { body: '   ' },
        { body: 'a'.repeat(10001) },
        { body: 'ok', followUp: 'a'.repeat(2001) },
        { body: 'ok', expectedEtag: 'abc' },
        { body: 'ok', diagnosis: 'x' },
      ]) {
        await put(w.dentist.token, w, b).expect(400);
      }
      expect(
        await ctx.db.clinicalNote.count({ where: { visitId: w.visit.id } }),
      ).toBe(0);
    });

    it('una sola evolución activa por visita: creaciones simultáneas, una prospera; descartar permite empezar otra sin borrar la anterior', async () => {
      const w = await world();
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          put(w.dentist.token, w, { body: `Intento ${i}` }),
        ),
      );
      expect(results.map((r) => r.status).sort((x, y) => x - y)).toEqual([
        201, 409, 409, 409, 409,
      ]);
      const d = results.find((r) => r.status === 201)!.body.evolution;
      await post(w.dentist.token, w, '/discard', {
        expectedEtag: d.etag,
      }).expect(400); // falta el motivo
      const discarded = expectStatus(
        await post(w.dentist.token, w, '/discard', {
          expectedEtag: d.etag,
          reason: 'Se empieza de nuevo',
        }),
        200,
      ).body.evolution;
      expect(discarded).toMatchObject({
        state: 'DISCARDED',
        stateLabel: 'Descartada',
        version: 2,
      });
      expect(
        (await getEvo(w.dentist.token, w).expect(200)).body.evolution,
      ).toBeNull(); // ya no hay una activa
      const again = await draft(w, 'Segundo intento');
      expect(again.id).not.toBe(d.id);
      expect(await rowsOf(d.id)).toHaveLength(2); // la descartada se conserva
    });
  });

  describe('cierre con reautenticación', () => {
    it('cierra con la contraseña en un solo paso: versión inmutable, huella de integridad y aviso de que NO es una firma', async () => {
      const w = await world();
      const d = await draft(w, 'Texto final de la evolución');
      const res = expectStatus(
        await post(w.dentist.token, w, '/close', {
          expectedEtag: d.etag,
          password: PASSWORD,
        }),
        200,
      );
      expect(res.body.evolution).toMatchObject({
        state: 'CLOSED',
        stateLabel: 'Cerrada',
        version: 2,
        revision: 0,
        etag: '2.0',
        body: 'Texto final de la evolución',
      });
      expect(res.body.evolution.closure).toMatchObject({
        isSignature: false,
        confirmedByUserId: w.dentist.user.id,
      });
      expect(res.body.evolution.closure.integrityHash).toMatch(
        /^[0-9a-f]{64}$/,
      );
      expect(res.body.evolution.closure.notice).toMatch(
        /No es una firma digital, legal ni clínica/,
      );
      expect(res.body.reauth).toMatchObject({ isSignature: false });
      expect(res.body.reauth.notice).toMatch(
        /No es una firma digital, legal ni clínica/,
      );
      const [v1, v2] = await rowsOf(d.id);
      expect(v1).toMatchObject({
        status: 'DRAFT',
        currentKey: null,
        visitKey: null,
      });
      expect(v2).toMatchObject({
        status: 'CLOSED',
        supersedesId: v1!.id,
        currentKey: d.id,
        visitKey: w.visit.id,
        changeKind: 'CLOSED',
      });
      expect(v2!.reauthProofId).toBeTruthy();
      expect(v2!.contentHash).toBe(res.body.evolution.closure.integrityHash);
      const logs = await auditOf(d.id);
      expect(logs.map((l) => l.action)).toEqual([
        'CLINICAL_NOTE_CREATED',
        'CLINICAL_NOTE_CLOSED',
      ]);
      expect(logs[1]!.summary).toMatchObject({
        version: 2,
        reauthenticated: true,
        isSignature: false,
      });
      expect(
        await ctx.db.auditLog.count({
          where: { userId: w.dentist.user.id, action: 'REAUTH_CONSUMED' },
        }),
      ).toBe(1);
    });

    it('también con una prueba emitida antes (para ESTA evolución); contraseña incorrecta, prueba ajena, reutilizada o ambas/ninguna: no cierra', async () => {
      const w = await world();
      const d = await draft(w);
      const bad = await post(w.dentist.token, w, '/close', {
        expectedEtag: d.etag,
        password: 'Incorrecta-12345',
      }).expect(401);
      expect(JSON.stringify(bad.body)).not.toContain('Incorrecta-12345');
      await post(w.dentist.token, w, '/close', { expectedEtag: d.etag }).expect(
        400,
      );
      await post(w.dentist.token, w, '/close', {
        expectedEtag: d.etag,
        password: PASSWORD,
        reauthToken: 'x'.repeat(20),
      }).expect(400);
      const otherTarget = await reauthProofFor(
        ctx,
        w.dentist.token,
        'CLOSE_CLINICAL_NOTE',
        GHOST,
      );
      expect(
        (
          await post(w.dentist.token, w, '/close', {
            expectedEtag: d.etag,
            reauthToken: otherTarget,
          }).expect(403)
        ).body.code,
      ).toBe('REAUTHENTICATION_REQUIRED');
      const otherPurpose = await reauthProofFor(
        ctx,
        w.dentist.token,
        'CORRECT_CLINICAL_NOTE',
        d.id,
      );
      await post(w.dentist.token, w, '/close', {
        expectedEtag: d.etag,
        reauthToken: otherPurpose,
      }).expect(403);
      expect(await rowsOf(d.id)).toHaveLength(1);
      const proof = await reauthProofFor(
        ctx,
        w.dentist.token,
        'CLOSE_CLINICAL_NOTE',
        d.id,
      );
      expectStatus(
        await post(w.dentist.token, w, '/close', {
          expectedEtag: d.etag,
          reauthToken: proof,
        }),
        200,
      );
      // la misma prueba no sirve dos veces
      const w2 = await world();
      const d2 = await draft(w2);
      const p2 = await reauthProofFor(
        ctx,
        w2.dentist.token,
        'CLOSE_CLINICAL_NOTE',
        d2.id,
      );
      await post(w2.dentist.token, w2, '/close', {
        expectedEtag: d2.etag,
        reauthToken: p2,
      }).expect(200);
      const reasons = (
        await ctx.db.auditLog.findMany({
          where: { userId: w.dentist.user.id, action: 'REAUTH_REJECTED' },
        })
      )
        .map((l) => (l.summary as { reason: string }).reason)
        .sort((a, b) => a.localeCompare(b));
      expect(reasons).toEqual(['other_purpose', 'other_target']);
      expect(
        (
          await ctx.db.auditLog.findMany({
            where: {
              userId: w.dentist.user.id,
              action: 'CLINICAL_ACCESS_DENIED',
            },
          })
        ).length,
      ).toBeGreaterThanOrEqual(2);
    });

    it('una evolución cerrada no se edita ni se borra: ni por la API ni por la base de datos', async () => {
      const w = await world();
      const c = await closed(w, 'Texto cerrado original');
      const err = await put(w.dentist.token, w, {
        body: 'Intento de edición',
        expectedEtag: c.etag,
      }).expect(409);
      expect(err.body.code).toBe('NOT_A_DRAFT');
      await post(w.dentist.token, w, '/discard', {
        expectedEtag: c.etag,
        reason: 'No aplica',
      }).expect(409);
      const [v1, v2] = await rowsOf(c.id);
      const sql = (t: string, ...a: unknown[]) =>
        ctx.db.$executeRawUnsafe(t, ...a);
      await expect(
        sql(
          "UPDATE clinical_notes SET body = 'Reescrito' WHERE id = ?",
          v2!.id,
        ),
      ).rejects.toThrow(/cerrada no se edita|inmutable/);
      await expect(
        sql(
          "UPDATE clinical_notes SET body = 'Reescrito' WHERE id = ?",
          v1!.id,
        ),
      ).rejects.toThrow(/no se edita/);
      await expect(
        sql('DELETE FROM clinical_notes WHERE id = ?', v2!.id),
      ).rejects.toThrow(/no se eliminan/);
      await expect(
        sql(
          'UPDATE clinical_notes SET current_key = item_id, visit_key = visit_id WHERE id = ?',
          v1!.id,
        ),
      ).rejects.toThrow();
      await expect(
        sql(
          "UPDATE clinical_notes SET content_hash = REPEAT('a', 64) WHERE id = ?",
          v2!.id,
        ),
      ).rejects.toThrow(/inmutable/);
      expect((await rowsOf(c.id)).find((r) => r.version === 2)!.body).toBe(
        'Texto cerrado original',
      );
    });

    it('la base impone el encadenamiento: cierre sin huella ni reautenticación, saltos de versión y transiciones inválidas', async () => {
      const w = await world();
      const d = await draft(w);
      const [v1] = await rowsOf(d.id);
      await ctx.db.clinicalNote.update({
        where: { id: v1!.id },
        data: { currentKey: null, visitKey: null },
      });
      const row = {
        clinicId: w.clinic.id,
        patientId: w.patientId,
        visitId: w.visit.id,
        itemId: d.id,
        body: 'x',
        createdById: w.dentist.user.id,
        supersedesId: v1!.id,
        currentKey: d.id,
      };
      await expect(
        ctx.db.clinicalNote.create({
          data: {
            ...row,
            version: 2,
            status: 'CLOSED',
            visitKey: w.visit.id,
            changeKind: 'CLOSED',
          },
        }),
      ).rejects.toThrow(/hash|reautenticación/);
      await expect(
        ctx.db.clinicalNote.create({
          data: {
            ...row,
            version: 3,
            status: 'DRAFT',
            visitKey: w.visit.id,
            changeKind: 'CLOSED',
          },
        }),
      ).rejects.toThrow();
      await expect(
        ctx.db.clinicalNote.create({
          data: {
            ...row,
            version: 2,
            status: 'ENTERED_IN_ERROR',
            visitKey: null,
            changeKind: 'MARKED_IN_ERROR',
            changeReason: 'Motivo válido',
            reauthProofId: GHOST,
          },
        }),
      ).rejects.toThrow(/transición/);
      await expect(
        ctx.db.clinicalNote.create({
          data: {
            ...row,
            version: 2,
            status: 'DISCARDED',
            visitKey: null,
            changeKind: 'DISCARDED',
          },
        }),
      ).rejects.toThrow(/motivo/);
      await expect(
        ctx.db.clinicalNote.create({
          data: {
            ...row,
            version: 2,
            status: 'DISCARDED',
            visitKey: w.visit.id,
            changeKind: 'DISCARDED',
            changeReason: 'Motivo válido',
          },
        }),
      ).rejects.toThrow(/clave de visita/);
      expect(await rowsOf(d.id)).toHaveLength(1);
    });
  });

  describe('corrección, rectificación y errores: nueva versión enlazada con motivo', () => {
    it('corregir y rectificar crean versiones nuevas (estado Corregida), enlazadas, con motivo y reautenticación; las anteriores quedan intactas', async () => {
      const w = await world();
      const c = await closed(w, 'Texto cerrado original');
      const hash1 = (await rowsOf(c.id))[1]!.contentHash;
      await post(w.dentist.token, w, '/correct', {
        expectedEtag: c.etag,
        password: PASSWORD,
        body: 'Texto corregido',
      }).expect(400); // sin motivo
      await post(w.dentist.token, w, '/correct', {
        expectedEtag: c.etag,
        password: PASSWORD,
        reason: 'Sin cambios reales',
      }).expect(400);
      await post(w.dentist.token, w, '/correct', {
        expectedEtag: c.etag,
        reason: 'Sin reautenticación',
        body: 'Texto corregido',
      }).expect(400);
      await post(w.dentist.token, w, '/correct', {
        expectedEtag: c.etag,
        password: 'Incorrecta-12345',
        reason: 'Contraseña mal',
        body: 'Texto corregido',
      }).expect(401);
      await post(w.dentist.token, w, '/correct', {
        expectedEtag: '2.9',
        password: PASSWORD,
        reason: 'Etag viejo',
        body: 'Texto corregido',
      }).expect(409);
      const fixed = expectStatus(
        await post(w.dentist.token, w, '/correct', {
          expectedEtag: c.etag,
          password: PASSWORD,
          reason: 'Error de transcripción',
          body: 'Texto corregido',
        }),
        200,
      ).body.evolution;
      expect(fixed).toMatchObject({
        state: 'CORRECTED',
        stateLabel: 'Corregida',
        version: 3,
        body: 'Texto corregido',
        lastChange: { kind: 'CORRECTED', reason: 'Error de transcripción' },
      });
      expect(fixed.closure.integrityHash).not.toBe(hash1);
      const rect = expectStatus(
        await post(w.dentist.token, w, '/rectify', {
          expectedEtag: fixed.etag,
          password: PASSWORD,
          reason: 'El paciente aclaró un dato',
          followUp: 'Control en una semana',
        }),
        200,
      ).body.evolution;
      expect(rect).toMatchObject({
        state: 'CORRECTED',
        version: 4,
        followUp: 'Control en una semana',
        lastChange: { kind: 'RECTIFIED' },
      });
      const rows = await rowsOf(c.id);
      expect(rows.map((r) => [r.version, r.changeKind, r.status])).toEqual([
        [1, 'CREATED', 'DRAFT'],
        [2, 'CLOSED', 'CLOSED'],
        [3, 'CORRECTED', 'CLOSED'],
        [4, 'RECTIFIED', 'CLOSED'],
      ]);
      expect(rows.map((r) => r.supersedesId)).toEqual([
        null,
        ...rows.slice(0, -1).map((r) => r.id),
      ]);
      expect(rows.filter((r) => r.currentKey)).toHaveLength(1);
      expect(rows[1]!.body).toBe('Texto cerrado original'); // la cerrada original sigue intacta
      const versions = (
        await getEvo(w.dentist.token, w, '/versions').expect(200)
      ).body.versions;
      expect(versions.map((v: { version: number }) => v.version)).toEqual([
        4, 3, 2, 1,
      ]);
      expect(
        versions.find((v: { version: number }) => v.version === 2).body,
      ).toBe('Texto cerrado original');
      expect(
        rows.every(
          (r) =>
            r.version === 1 ||
            r.changeKind === 'CLOSED' ||
            (r.changeReason ?? '').length >= 3,
        ),
      ).toBe(true);
    });

    it('registrar por error conserva el historial; después se puede redactar otra evolución', async () => {
      const w = await world();
      const c = await closed(w);
      await post(w.dentist.token, w, '/mark-error', {
        expectedEtag: c.etag,
        password: PASSWORD,
      }).expect(400); // sin motivo
      const e = expectStatus(
        await post(w.dentist.token, w, '/mark-error', {
          expectedEtag: c.etag,
          password: PASSWORD,
          reason: 'Paciente equivocado',
        }),
        200,
      ).body.evolution;
      expect(e).toMatchObject({
        state: 'ENTERED_IN_ERROR',
        stateLabel: 'Registrada por error',
        version: 3,
      });
      await post(w.dentist.token, w, '/correct', {
        expectedEtag: e.etag,
        password: PASSWORD,
        reason: 'Tarde',
        body: 'x',
      }).expect(404); // ya no hay una evolución activa
      expect(
        (await getEvo(w.dentist.token, w).expect(200)).body.evolution,
      ).toBeNull();
      const next = await draft(w, 'Evolución correcta');
      expect(next.id).not.toBe(c.id);
      expect(await rowsOf(c.id)).toHaveLength(3);
      expect(
        (await getEvo(w.dentist.token, w, '/versions').expect(200)).body
          .versions[0].id,
      ).toBe(next.id);
    });

    it('corregir sigue siendo posible con la visita ya cerrada (queda versionado)', async () => {
      const w = await world();
      const c = await closed(w);
      await ctx
        .http()
        .post(`${base(w)}/close`)
        .set(bearer(w.dentist.token))
        .send({ expectedVersion: 1 })
        .expect(200);
      expectStatus(
        await post(w.dentist.token, w, '/correct', {
          expectedEtag: c.etag,
          password: PASSWORD,
          reason: 'Aclaración posterior',
          body: 'Texto con aclaración',
        }),
        200,
      );
      await put(w.dentist.token, w, {
        body: 'Nuevo',
        expectedEtag: '3.0',
      }).expect(409);
    });
  });

  describe('visita y evolución', () => {
    it('la visita no se cierra con un borrador (OPEN_NOTE) ni se cancela con una evolución vigente (HAS_NOTES)', async () => {
      const w = await world();
      const d = await draft(w);
      const blocked = await ctx
        .http()
        .post(`${base(w)}/close`)
        .set(bearer(w.dentist.token))
        .send({ expectedVersion: 1 })
        .expect(409);
      expect(blocked.body).toMatchObject({ code: 'OPEN_NOTE', count: 1 });
      await ctx
        .http()
        .post(`${base(w)}/cancel`)
        .set(bearer(w.dentist.token))
        .send({ expectedVersion: 1, reason: 'No procede' })
        .expect(409);
      await post(w.dentist.token, w, '/close', {
        expectedEtag: d.etag,
        password: PASSWORD,
      }).expect(200);
      expect(
        (
          await ctx
            .http()
            .post(`${base(w)}/cancel`)
            .set(bearer(w.dentist.token))
            .send({ expectedVersion: 1, reason: 'No procede' })
            .expect(409)
        ).body.code,
      ).toBe('HAS_NOTES');
      await ctx
        .http()
        .post(`${base(w)}/close`)
        .set(bearer(w.dentist.token))
        .send({ expectedVersion: 1 })
        .expect(200);
      // visita cerrada: no se redacta evolución nueva
      const w2 = await world();
      await ctx
        .http()
        .post(`${base(w2)}/close`)
        .set(bearer(w2.dentist.token))
        .send({ expectedVersion: 1 })
        .expect(200);
      expect(
        (await put(w2.dentist.token, w2, { body: 'Tarde' }).expect(409)).body
          .code,
      ).toBe('INVALID_STATE');
    });

    it('la base de datos también lo impone (visita con borrador, evolución en visita cerrada)', async () => {
      const w = await world();
      await draft(w);
      await expect(
        ctx.db.clinicalVisit.update({
          where: { id: w.visit.id },
          data: {
            status: 'CLOSED',
            openKey: null,
            closedAt: new Date(),
            version: 2,
          },
        }),
      ).rejects.toThrow(/borrador/);
      const w2 = await world();
      await ctx
        .http()
        .post(`${base(w2)}/close`)
        .set(bearer(w2.dentist.token))
        .send({ expectedVersion: 1 })
        .expect(200);
      const itemId = crypto.randomUUID();
      await expect(
        ctx.db.clinicalNote.create({
          data: {
            clinicId: w2.clinic.id,
            patientId: w2.patientId,
            visitId: w2.visit.id,
            itemId,
            version: 1,
            currentKey: itemId,
            visitKey: w2.visit.id,
            status: 'DRAFT',
            body: 'x',
            changeKind: 'CREATED',
            createdById: w2.dentist.user.id,
          },
        }),
      ).rejects.toThrow(/visita abierta/);
    });
  });

  describe('quién accede', () => {
    it('otro odontólogo con relación lee lo cerrado pero no ve el texto de un borrador ni escribe; el responsable solo desde la sede de la visita', async () => {
      const w = await world();
      const colleague = await fx.userWithRole('DENTIST', {
        clinicId: w.clinic.id,
        branchId: w.branchA.id,
      });
      await assignCare(ctx, w.reception.token, w.patientId, colleague.user.id);
      const cTok = await loginInContext(ctx, colleague.user.email, {
        clinicId: w.clinic.id,
        branchId: w.branchA.id,
      });
      const d = await draft(w, 'Texto privado del borrador');
      const seen = (await getEvo(cTok, w).expect(200)).body.evolution;
      expect(seen).toMatchObject({
        state: 'DRAFT',
        contentHidden: true,
        body: null,
        followUp: null,
      });
      expect(JSON.stringify(seen)).not.toContain('Texto privado');
      expect(
        (
          await put(cTok, w, {
            body: 'Intento ajeno',
            expectedEtag: d.etag,
          }).expect(403)
        ).body.code,
      ).toBe('NOT_VISIT_RESPONSIBLE');
      await post(cTok, w, '/close', {
        expectedEtag: d.etag,
        password: PASSWORD,
      }).expect(403);
      // desde otra sede, el responsable lee pero no escribe
      expect(
        (
          await put(w.dentist.tokenB, w, {
            body: 'Otra sede',
            expectedEtag: d.etag,
          }).expect(403)
        ).body.code,
      ).toBe('WRONG_BRANCH');
      await post(w.dentist.tokenB, w, '/close', {
        expectedEtag: d.etag,
        password: PASSWORD,
      }).expect(403);
      expect(
        (await getEvo(w.dentist.tokenB, w).expect(200)).body.evolution.body,
      ).toBe('Texto privado del borrador');
      // cerrada: el colega ya la lee completa
      await post(w.dentist.token, w, '/close', {
        expectedEtag: d.etag,
        password: PASSWORD,
      }).expect(200);
      expect((await getEvo(cTok, w).expect(200)).body.evolution).toMatchObject({
        state: 'CLOSED',
        body: 'Texto privado del borrador',
        contentHidden: false,
      });
      expect(
        (await getEvo(cTok, w, '/versions').expect(200)).body.versions,
      ).toHaveLength(2);
    });

    it('asistente: nada de la evolución (solo alertas); Director: sin autorización no lee, con ella solo lee y el borrador sigue oculto; nunca escribe', async () => {
      const w = await world();
      const d = await draft(w, 'Texto del borrador');
      for (const p of ['', '/versions'])
        expect(
          (await getEvo(w.assistant.token, w, p).expect(403)).body.code,
        ).toBe('CLINICAL_LIMITED_VIEW');
      await put(w.assistant.token, w, {
        body: 'x',
        expectedEtag: d.etag,
      }).expect(403);
      await post(w.assistant.token, w, '/close', {
        expectedEtag: d.etag,
        password: PASSWORD,
      }).expect(403);
      expect((await getEvo(w.director.token, w).expect(403)).body.code).toBe(
        'CLINICAL_JUSTIFICATION_REQUIRED',
      );
      expectStatus(await grantReadAll(ctx, w.director.token, w.patientId), 201);
      expect(
        (await getEvo(w.director.token, w).expect(200)).body.evolution,
      ).toMatchObject({ contentHidden: true, body: null });
      await post(w.dentist.token, w, '/close', {
        expectedEtag: d.etag,
        password: PASSWORD,
      }).expect(200);
      expect(
        (await getEvo(w.director.token, w).expect(200)).body.evolution,
      ).toMatchObject({ state: 'CLOSED', body: 'Texto del borrador' });
      await put(w.director.token, w, { body: 'x', expectedEtag: '2.0' }).expect(
        403,
      );
      await post(w.director.token, w, '/correct', {
        expectedEtag: '2.0',
        password: PASSWORD,
        reason: 'No debe',
        body: 'x',
      }).expect(403);
      expect(
        await ctx.db.auditLog.count({
          where: { patientId: w.patientId, action: 'CLINICAL_READ_ALL_READ' },
        }),
      ).toBe(2);
    });

    it('administración, caja y plataforma: 403 genérico idéntico exista o no el paciente; recepción solo lee; otra clínica: 404 uniforme', async () => {
      const w = await world();
      await closed(w);
      await getEvo(w.reception.token, w).expect(200);
      await put(w.reception.token, w, { body: 'x' }).expect(403);
      const { user } = await fx.userWithRole('PLATFORM_ADMIN');
      const platform = await loginInContext(ctx, user.email);
      for (const t of [
        platform,
        w.admin.token,
        w.cashier.token,
      ]) {
        const real = await getEvo(t, w).expect(403);
        const ghost = await ctx
          .http()
          .get(`/v1/patients/${GHOST}/clinical/visits/${w.visit.id}/evolution`)
          .set(bearer(t))
          .expect(403);
        expect(real.body.message).toBe(ghost.body.message);
        await put(t, w, { body: 'x' }).expect(403);
      }
      const other = await fx.clinic();
      const dentistB = await actorIn(ctx, fx, 'DENTIST', {
        clinicId: other.id,
        branchId: (await fx.branch(other.id)).id,
      });
      const foreign = await getEvo(dentistB.token, w).expect(404);
      const ghost = await ctx
        .http()
        .get(`/v1/patients/${GHOST}/clinical/visits/${GHOST}/evolution`)
        .set(bearer(dentistB.token))
        .expect(404);
      expect(foreign.body.message).toBe(ghost.body.message);
      await put(dentistB.token, w, { body: 'x' }).expect(404);
      await ctx
        .http()
        .get(`${base(w)}/sheet`)
        .set(bearer(dentistB.token))
        .expect(404);
      // visita de A con un paciente propio de B: tampoco existe
      const receptionB = await actorIn(ctx, fx, 'RECEPTIONIST', {
        clinicId: other.id,
      });
      const { id: pB } = await createPatient(ctx, receptionB.token);
      await assignCare(ctx, receptionB.token, pB, dentistB.user.id);
      await ctx
        .http()
        .get(`/v1/patients/${pB}/clinical/visits/${w.visit.id}/evolution`)
        .set(bearer(dentistB.token))
        .expect(404);
      await ctx
        .http()
        .put(`/v1/patients/${pB}/clinical/visits/${w.visit.id}/evolution`)
        .set(bearer(dentistB.token))
        .send({ body: 'x' })
        .expect(404);
    });

    it('relación revocada o de otro odontólogo: ni lee ni escribe', async () => {
      const w = await world();
      const d = await draft(w);
      const stranger = await actorIn(ctx, fx, 'DENTIST', {
        clinicId: w.clinic.id,
        branchId: w.branchA.id,
      });
      expect((await getEvo(stranger.token, w).expect(403)).body.code).toBe(
        'NO_CARE_RELATIONSHIP',
      );
      await revokeCareReq(ctx, w.reception.token, w.rel.id).expect(200);
      expect((await getEvo(w.dentist.token, w).expect(403)).body.code).toBe(
        'NO_CARE_RELATIONSHIP',
      );
      await put(w.dentist.token, w, {
        body: 'Tarde',
        expectedEtag: d.etag,
      }).expect(403);
      await post(w.dentist.token, w, '/close', {
        expectedEtag: d.etag,
        password: PASSWORD,
      }).expect(403);
      expect(await rowsOf(d.id)).toHaveLength(1);
    });
  });

  describe('auditoría y datos sin contenido narrativo', () => {
    it('ni la auditoría, ni los listados, ni los errores, ni los logs contienen el relato, el seguimiento, los motivos ni la contraseña', async () => {
      const w = await world();
      const marker = uniq('RELATO-');
      const d = await draft(w, `${marker}-v1`, { followUp: `${marker}-seg` });
      await put(w.dentist.token, w, {
        body: `${marker}-v1b`,
        followUp: `${marker}-seg`,
        expectedEtag: d.etag,
      }).expect(200);
      await put(w.dentist.token, w, {
        body: `${marker}-conflicto`,
        expectedEtag: '1.0',
      }).expect(409);
      await post(w.dentist.token, w, '/close', {
        expectedEtag: '1.1',
        password: PASSWORD,
      }).expect(200);
      await post(w.dentist.token, w, '/correct', {
        expectedEtag: '2.0',
        password: PASSWORD,
        reason: `${marker}-motivo`,
        body: `${marker}-corregido`,
      }).expect(200);
      await post(w.dentist.token, w, '/correct', {
        expectedEtag: '2.0',
        password: 'Mala-Clave-12345',
        reason: `${marker}-m2`,
        body: `${marker}-x`,
      }).expect(401);
      await put(w.dentist.token, w, {
        body: `${marker}`,
        expectedEtag: 'xx',
      }).expect(400);
      expectStatus(await grantReadAll(ctx, w.director.token, w.patientId), 201);
      await getEvo(w.director.token, w, '/versions').expect(200);

      const has = (x: unknown) => JSON.stringify(x).includes(marker);
      expect(has(await ctx.db.auditLog.findMany({}))).toBe(false);
      const dump = JSON.stringify(await ctx.db.auditLog.findMany({}));
      expect(dump).not.toContain(PASSWORD);
      expect(dump).not.toContain('Mala-Clave-12345');
      for (const q of [
        '',
        '?action=CLINICAL_NOTE_CLOSED',
        `?patientId=${w.patientId}&limit=100`,
      ])
        expect(
          (
            await ctx
              .http()
              .get(`/v1/audit-logs${q}`)
              .set(bearer(w.admin.token))
              .expect(200)
          ).text,
        ).not.toContain(marker);
      const lastName = (
        await ctx.db.patient.findUniqueOrThrow({ where: { id: w.patientId } })
      ).lastName;
      const responses = [
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
          .get('/v1/care-relationships')
          .set(bearer(w.admin.token)),
        await ctx
          .http()
          .get(`/v1/patients/${w.patientId}/clinical-summary`)
          .set(bearer(w.assistant.token)),
        await ctx
          .http()
          .get(`/v1/patients/${w.patientId}/clinical/alerts`)
          .set(bearer(w.assistant.token)),
        await ctx
          .http()
          .get(`/v1/patients/${w.patientId}/clinical/visits`)
          .set(bearer(w.dentist.token)),
        await ctx
          .http()
          .get(`/v1/patients/${w.patientId}/clinical/diagnoses`)
          .set(bearer(w.dentist.token)),
        await getEvo(w.dentist.token, { ...w, patientId: GHOST } as W),
      ];
      for (const r of responses) expect(r.text).not.toContain(marker);
      expect(logger.lines.join('\n')).not.toContain(marker);
      expect(logger.lines.join('\n')).not.toContain(PASSWORD);
      expect(logger.lines.length).toBeGreaterThan(0);
    });

    it('falla cerrada: si falla la auditoría la lectura da 503 sin datos y las escrituras se revierten (la prueba de cierre no se gasta)', async () => {
      const w = await world();
      const d = await draft(w, 'Texto que no debe filtrarse');
      const audit = ctx.app.get(AuditService);
      const original = audit.record.bind(audit);
      vi.spyOn(audit, 'record').mockImplementation(async (entry, tx) => {
        if (
          entry.action === 'CLINICAL_RECORD_VIEWED' ||
          entry.action.startsWith('CLINICAL_NOTE_')
        )
          throw new Error('auditoría caída');
        return original(entry, tx);
      });
      const read = await getEvo(w.dentist.token, w).expect(503);
      expect(read.text).not.toContain('Texto que no debe');
      expect(
        (
          await put(w.dentist.token, w, {
            body: 'Cambio',
            expectedEtag: d.etag,
          })
        ).status,
      ).toBeGreaterThanOrEqual(500);
      const proof = await reauthProofFor(
        ctx,
        w.dentist.token,
        'CLOSE_CLINICAL_NOTE',
        d.id,
      );
      expect(
        (
          await post(w.dentist.token, w, '/close', {
            expectedEtag: d.etag,
            reauthToken: proof,
          })
        ).status,
      ).toBeGreaterThanOrEqual(500);
      vi.restoreAllMocks();
      const rows = await rowsOf(d.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: 'DRAFT',
        body: 'Texto que no debe filtrarse',
        currentKey: d.id,
      });
      // la transacción revirtió también el consumo: la misma prueba sigue sirviendo
      expectStatus(
        await post(w.dentist.token, w, '/close', {
          expectedEtag: d.etag,
          reauthToken: proof,
        }),
        200,
      );
    });
  });

  describe('ficha de atención (una sola pantalla)', () => {
    it('una lectura entrega alertas, diagnóstico, procedimientos y evolución, con textos claros, estados visibles y las acciones disponibles', async () => {
      const w = await world();
      const t = w.dentist.token;
      const pBase = `/v1/patients/${w.patientId}/clinical`;
      await ctx
        .http()
        .post(`${pBase}/history`)
        .set(bearer(t))
        .send({
          kind: 'ALLERGY',
          label: 'Alergia de ejemplo',
          source: 'PATIENT',
          isCritical: true,
        })
        .expect(201);
      await ctx
        .http()
        .post(`${pBase}/alerts`)
        .set(bearer(t))
        .send({
          severity: 'WARNING',
          text: 'Aviso de ejemplo',
          source: 'PROFESSIONAL',
        })
        .expect(201);
      const def = (
        await ctx
          .http()
          .post('/v1/procedure-definitions')
          .set(bearer(w.admin.token))
          .send({
            code: uniq('SHEET').toUpperCase(),
            name: 'Restauración de ejemplo',
            requiresClinicalConsent: true,
          })
          .expect(201)
      ).body;
      await ctx
        .http()
        .post(`${base(w)}/diagnoses`)
        .set(bearer(t))
        .send({
          description: 'Diagnóstico de ejemplo',
          certainty: 'PRESUMPTIVE',
        })
        .expect(201);
      await ctx
        .http()
        .post(`${base(w)}/procedures`)
        .set(bearer(t))
        .send({ definitionId: def.id, notes: 'Notas de ejemplo' })
        .expect(201);
      await draft(w, 'Borrador de ejemplo');

      const sheet = expectStatus(
        await ctx
          .http()
          .get(`${base(w)}/sheet`)
          .set(bearer(t)),
        200,
      ).body;
      // el orden de lectura: primero las alertas, luego diagnóstico, procedimientos y evolución
      const order = Object.keys(sheet);
      const at = (k: string) => order.indexOf(k);
      expect(order[0]).toBe('alerts');
      expect(at('alerts')).toBeLessThan(at('diagnoses'));
      expect(at('diagnoses')).toBeLessThan(at('procedures'));
      expect(at('procedures')).toBeLessThan(at('evolution'));
      expect(
        sheet.alerts.items
          .map((a: { label: string }) => a.label)
          .sort((x: string, y: string) => x.localeCompare(y)),
      ).toEqual(['Alergia de ejemplo', 'Aviso de ejemplo']);
      expect(sheet.alerts.items[0]).toMatchObject({ severity: 'CRITICAL' });
      expect(sheet.allergyAssessment).toMatchObject({
        status: 'ALLERGIES_RECORDED',
        label: 'Tiene alergias registradas',
      });
      expect(sheet.consent).toMatchObject({
        state: 'MISSING',
        label: 'Falta el consentimiento clínico',
      });
      expect(sheet.visit).toMatchObject({
        status: 'OPEN',
        statusLabel: 'Abierta',
        number: 1,
      });
      expect(sheet.diagnoses[0]).toMatchObject({
        certaintyLabel: 'Presuntivo',
        statusLabel: 'Vigente',
      });
      expect(sheet.procedures[0]).toMatchObject({
        name: 'Restauración de ejemplo',
        statusLabel: 'En curso',
        requiresConsent: true,
        closeBlockedByConsent: true,
        canClose: false,
      });
      expect(sheet.procedures[0].closeBlockedMessage).toMatch(
        /falta el consentimiento clínico/,
      );
      expect(sheet.evolution).toMatchObject({
        state: 'DRAFT',
        stateLabel: 'Borrador',
        body: 'Borrador de ejemplo',
      });
      expect(sheet.actions).toMatchObject({
        readOnly: false,
        canAddDiagnosis: true,
        canWriteEvolution: true,
        canCloseEvolution: true,
        canCorrectEvolution: false,
        canCloseVisit: false,
      });
      expect(
        sheet.actions.closeVisitBlockedBy.sort((a: string, b: string) =>
          a.localeCompare(b),
        ),
      ).toEqual(['OPEN_NOTE', 'OPEN_PROCEDURES']);
      expect(sheet.labels.note.CORRECTED).toBe('Corregida');
      expect(sheet.notice).toMatch(/declaraciones del profesional/);

      // con el consentimiento registrado el procedimiento ya se puede cerrar
      await ctx
        .http()
        .post(`/v1/patients/${w.patientId}/consents`)
        .set(bearer(w.reception.token))
        .send(clinicalConsentBody())
        .expect(201);
      const after = (
        await ctx
          .http()
          .get(`${base(w)}/sheet`)
          .set(bearer(t))
          .expect(200)
      ).body;
      expect(after.procedures[0]).toMatchObject({
        closeBlockedByConsent: false,
        canClose: true,
      });
      expect(after.consent.state).toBe('GRANTED');
      // una lectura = una auditoría previa, sección visit_sheet
      expect(
        (
          await ctx.db.auditLog.findMany({
            where: { patientId: w.patientId, action: 'CLINICAL_RECORD_VIEWED' },
          })
        ).filter(
          (l) =>
            (l.summary as { sections: string[] }).sections[0] === 'visit_sheet',
        ),
      ).toHaveLength(2);
    });

    it('solo lectura para colega y Director; el asistente, administración y recepción no la reciben; la ficha de una visita cerrada ofrece corregir', async () => {
      const w = await world();
      const c = await closed(w, 'Texto cerrado');
      const colleague = await fx.userWithRole('DENTIST', {
        clinicId: w.clinic.id,
        branchId: w.branchA.id,
      });
      await assignCare(ctx, w.reception.token, w.patientId, colleague.user.id);
      const cTok = await loginInContext(ctx, colleague.user.email, {
        clinicId: w.clinic.id,
        branchId: w.branchA.id,
      });
      const sheet = (path: string, t: string) =>
        ctx
          .http()
          .get(`${base(w)}/${path}`)
          .set(bearer(t));
      const own = (await sheet('sheet', w.dentist.token).expect(200)).body;
      expect(own.actions).toMatchObject({
        canCorrectEvolution: true,
        canWriteEvolution: false,
        canCloseEvolution: false,
        canCloseVisit: true,
      });
      expect(own.evolution).toMatchObject({
        state: 'CLOSED',
        stateLabel: 'Cerrada',
        closure: { isSignature: false },
      });
      const other = (await sheet('sheet', cTok).expect(200)).body;
      expect(other.actions).toMatchObject({
        readOnly: true,
        canAddDiagnosis: false,
        canWriteEvolution: false,
        canCorrectEvolution: false,
        canCloseVisit: false,
      });
      expect(
        (await sheet('sheet', w.assistant.token).expect(403)).body.code,
      ).toBe('CLINICAL_LIMITED_VIEW');
      for (const t of [w.admin.token, w.cashier.token])
        await sheet('sheet', t).expect(403);
      const rec = (await sheet('sheet', w.reception.token).expect(200)).body;
      expect(rec.access).toMatchObject({ level: 'VIEW' });
      expect(rec.actions.readOnly).toBe(true);
      expect(Object.entries(rec.actions).filter(([k, v]) => k !== 'readOnly' && v === true)).toHaveLength(0);
      expect(
        (await sheet('sheet', w.director.token).expect(403)).body.code,
      ).toBe('CLINICAL_JUSTIFICATION_REQUIRED');
      expectStatus(await grantReadAll(ctx, w.director.token, w.patientId), 201);
      const dir = (await sheet('sheet', w.director.token).expect(200)).body;
      expect(dir.access).toMatchObject({ level: 'READ_ALL' });
      expect(
        Object.entries(dir.actions).filter(([k, v]) => k !== 'readOnly' && v === true),
      ).toHaveLength(0);
      expect(c.id).toBeTruthy();
    });
  });

  describe('concurrencia', () => {
    const sound = async (itemId: string) => {
      const rows = await rowsOf(itemId);
      expect(rows.map((r) => r.version)).toEqual(rows.map((_, i) => i + 1));
      expect(rows.filter((r) => r.currentKey !== null)).toHaveLength(1);
      return rows;
    };

    it('guardados simultáneos del borrador con el mismo etag: uno prospera', async () => {
      const w = await world();
      const d = await draft(w, 'Inicial');
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          put(w.dentist.token, w, {
            body: `Variante ${i}`,
            expectedEtag: d.etag,
          }),
        ),
      );
      expect(results.map((r) => r.status).sort((x, y) => x - y)).toEqual([
        200, 409, 409, 409, 409,
      ]);
      const rows = await sound(d.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.revision).toBe(1);
    });

    it('cerrar dos veces a la vez, o cerrar mientras se guarda: una sola versión cerrada y el contenido cerrado es coherente', async () => {
      for (let round = 0; round < 4; round++) {
        const w = await world();
        const d = await draft(w, 'Inicial');
        const [a, b, s] = await Promise.all([
          post(w.dentist.token, w, '/close', {
            expectedEtag: d.etag,
            password: PASSWORD,
          }),
          post(w.dentist.token, w, '/close', {
            expectedEtag: d.etag,
            password: PASSWORD,
          }),
          put(w.dentist.token, w, {
            body: 'Guardado concurrente',
            expectedEtag: d.etag,
          }),
        ]);
        const closes = [a, b].filter((r) => r.status === 200);
        expect(closes.length, `ronda ${round}`).toBeLessThanOrEqual(1);
        expect(
          [a, b, s].every((r) => [200, 409].includes(r.status)),
          `ronda ${round}`,
        ).toBe(true);
        const rows = await sound(d.id);
        const last = rows.at(-1)!;
        if (closes.length === 1) {
          // lo cerrado coincide exactamente con lo que se guardó antes del cierre
          expect(last.status).toBe('CLOSED');
          expect(last.body).toBe(
            s.status === 200 ? 'Guardado concurrente' : 'Inicial',
          );
          expect(
            await ctx.db.auditLog.count({
              where: { entityId: d.id, action: 'CLINICAL_NOTE_CLOSED' },
            }),
          ).toBe(1);
        } else {
          // el guardado ganó y cambió el etag: ambos cierres vieron un etag viejo (hay que volver a leer)
          expect(s.status).toBe(200);
          expect(last).toMatchObject({
            status: 'DRAFT',
            body: 'Guardado concurrente',
          });
        }
      }
    });

    it('correcciones simultáneas de una evolución cerrada: una prospera', async () => {
      const w = await world();
      const c = await closed(w);
      const results = await Promise.all(
        Array.from({ length: 4 }, (_, i) =>
          post(w.dentist.token, w, '/correct', {
            expectedEtag: c.etag,
            password: PASSWORD,
            reason: 'Corrección simultánea',
            body: `Corrección ${i}`,
          }),
        ),
      );
      expect(results.map((r) => r.status).sort((x, y) => x - y)).toEqual([
        200, 409, 409, 409,
      ]);
      expect(await sound(c.id)).toHaveLength(3);
    });

    it('cerrar la visita mientras se crea o guarda la evolución: nunca queda un borrador en una visita cerrada', async () => {
      for (let round = 0; round < 6; round++) {
        const w = await world();
        const [closedVisit, created] = await Promise.all([
          ctx
            .http()
            .post(`${base(w)}/close`)
            .set(bearer(w.dentist.token))
            .send({ expectedVersion: 1 }),
          put(w.dentist.token, w, { body: 'Concurrente' }),
        ]);
        const visit = await ctx.db.clinicalVisit.findUniqueOrThrow({
          where: { id: w.visit.id },
        });
        const drafts = await ctx.db.clinicalNote.count({
          where: {
            visitId: w.visit.id,
            currentKey: { not: null },
            status: 'DRAFT',
          },
        });
        if (closedVisit.status === 200) {
          expect(visit.status, `ronda ${round}`).toBe('CLOSED');
          expect(drafts, `ronda ${round}`).toBe(0);
          expect(created.status).toBe(409);
        } else {
          expect(closedVisit.status).toBe(409);
          expect(created.status).toBe(201);
          expect(visit.status).toBe('OPEN');
        }
      }
    });

    it('revocar la relación, retirar el rol o deshabilitar al odontólogo mientras escribe o cierra: nada se escribe tras la baja', async () => {
      for (let round = 0; round < 3; round++) {
        const w = await world();
        const d = await draft(w, 'Inicial');
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
        const [offRes, saved, closedRes] = await Promise.all([
          off,
          put(w.dentist.token, w, {
            body: 'Durante la baja',
            expectedEtag: d.etag,
          }),
          post(w.dentist.token, w, '/close', {
            expectedEtag: d.etag,
            password: PASSWORD,
          }),
        ]);
        if (Array.isArray(offRes))
          expect(offRes.every((r) => r.status === 200)).toBe(true);
        else expect((offRes as { status: number }).status).toBe(200);
        for (const r of [saved, closedRes])
          expect([200, 401, 403, 409], `ronda ${round}`).toContain(r.status);
        await sound(d.id);
        const after = await put(w.dentist.token, w, {
          body: 'Después de la baja',
          expectedEtag: '1.9',
        });
        expect([401, 403, 409]).toContain(after.status);
        const rows = await rowsOf(d.id);
        expect(rows.every((r) => r.body !== 'Después de la baja')).toBe(true);
        const audited = await ctx.db.auditLog.count({
          where: {
            entityId: d.id,
            action: {
              in: ['CLINICAL_NOTE_DRAFT_SAVED', 'CLINICAL_NOTE_CLOSED'],
            },
          },
        });
        expect(audited).toBe(
          [saved, closedRes].filter((r) => r.status === 200).length,
        );
      }
    });
  });
});
