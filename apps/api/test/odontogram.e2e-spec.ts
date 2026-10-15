import type { LoggerService } from '@nestjs/common';
import { vi } from 'vitest';
import { AuditService } from '../src/audit/audit.service.js';
import { odontogramSpec } from '../src/clinical/odontogram/odontogram-spec.js';
import {
  actorIn,
  assignCare,
  bearer,
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

/** Texto de un PDF generado por pdfkit (las cadenas de texto van en hexadecimal dentro de operadores TJ). */
const pdfText = (pdf: Buffer): string =>
  [...pdf.toString('latin1').matchAll(/\[(.*?)\] TJ/g)]
    .map((m) =>
      [...m[1]!.matchAll(/<([0-9a-f]+)>/g)]
        .map((h) => Buffer.from(h[1]!, 'hex').toString('latin1'))
        .join(''),
    )
    .join('\n');
const GHOST = '8e5f2c5a-7d3e-4f52-9d7c-3b7a1e9d6c11';
const expectStatus = <T extends { status: number; body: unknown }>(
  res: T,
  status: number,
): T => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res;
};
const doc = (teeth: Record<string, unknown> = {}, notes?: string) => ({
  schema: 'apidental.odontogram',
  schemaVersion: 1,
  teeth,
  ...(notes ? { notes } : {}),
});

describe('Odontograma digital versionado y exportable (3.5)', () => {
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
    const clinic = await fx.clinic('Clínica Demo (prueba)');
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
      firstName: 'Lucía',
      identifier: {
        type: 'DNI',
        number: String(90000000 + Math.floor(Math.random() * 9999)),
      },
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

  const url = (w: W, p = '') =>
    `/v1/patients/${w.patientId}/clinical/odontogram${p}`;
  const get = (t: string, w: W, p = '') =>
    ctx.http().get(url(w, p)).set(bearer(t));
  const post = (t: string, w: W, p: string, b: object = {}) =>
    ctx.http().post(url(w, p)).set(bearer(t)).send(b);
  const put = (t: string, w: W, b: object) =>
    ctx.http().put(url(w, '/draft')).set(bearer(t)).send(b);
  const rows = (patientId: string) =>
    ctx.db.clinicalOdontogram.findMany({
      where: { patientId },
      orderBy: { version: 'asc' },
    });
  const exp = (t: string, w: W, q = '') =>
    ctx
      .http()
      .get(url(w, `/export${q}`))
      .set(bearer(t))
      .buffer(true)
      .parse((res, cb) => {
        const c: Buffer[] = [];
        res.on('data', (d: Buffer) => c.push(d));
        res.on('end', () => cb(null, Buffer.concat(c)));
      });

  /** Primer odontograma guardado (versión 2). */
  async function saved(
    w: W,
    teeth: Record<string, unknown> = {
      '16': { surfaces: { O: { state: 'CARIES' } } },
      '36': { status: 'ABSENT' },
    },
    notes?: string,
  ) {
    const d = expectStatus(await post(w.dentist.token, w, '/draft'), 201).body
      .draft;
    const s = expectStatus(
      await put(w.dentist.token, w, {
        data: doc(teeth, notes),
        expectedEtag: d.etag,
      }),
      200,
    ).body.draft;
    return expectStatus(
      await post(w.dentist.token, w, '/close', { expectedEtag: s.etag }),
      200,
    ).body.odontogram as { version: number; etag: string };
  }
  const correctionDraft = async (
    w: W,
    purpose = 'CORRECTION',
    reason = 'Se corrige un registro',
  ) =>
    expectStatus(
      await post(w.dentist.token, w, '/draft', { purpose, reason }),
      201,
    ).body.draft as { etag: string; version: number };

  describe('especificación visual', () => {
    it('la ven los perfiles clínicos (no depende del paciente); no incluye estados que sugieran tratamientos', async () => {
      const w = await world();
      for (const t of [w.dentist.token, w.assistant.token, w.director.token]) {
        const spec = (
          await ctx
            .http()
            .get('/v1/clinical/odontogram/spec')
            .set(bearer(t))
            .expect(200)
        ).body;
        expect(spec).toMatchObject({
          numbering: 'FDI',
          schema: 'apidental.odontogram',
          schemaVersion: 1,
        });
        expect(spec.formatNotice).toMatch(/Formato clínico por validar/);
        expect(spec.formatNotice).toMatch(/MINSA/);
        expect(spec.surfaces.map((s: { code: string }) => s.code)).toEqual([
          'M',
          'D',
          'O',
          'V',
          'L',
        ]);
        expect(spec.teeth.permanent).toHaveLength(32);
        expect(spec.teeth.primary).toHaveLength(20);
        expect(spec.layout.permanent.upper).toHaveLength(16);
        expect(spec.cell.polygons.center).toBeDefined();
        const codes = [
          ...spec.surfaceStates,
          ...spec.toothStatuses,
          ...spec.marks,
        ].map((x: { code: string }) => x.code);
        for (const c of codes)
          expect(c).not.toMatch(
            /TREATMENT|INDICATED|EXTRACTION|RECOMMEND|PENDING|NEEDS|PLANNED|^TO_/i,
          );
        expect(
          spec.surfaceStates.every((s: { pattern: string }) => s.pattern),
        ).toBe(true); // nunca solo color
      }
      expect(odontogramSpec().example.teeth).toBeDefined();
      for (const t of [w.cashier.token, w.admin.token])
        await ctx
          .http()
          .get('/v1/clinical/odontogram/spec')
          .set(bearer(t))
          .expect(403);
      await ctx
        .http()
        .get('/v1/clinical/odontogram/spec')
        .set(bearer(w.reception.token))
        .expect(200);
    });
  });

  describe('versionado e inmutabilidad', () => {
    it('borrador → guardada: edita en el sitio con etag, guarda la versión con huella de integridad y la deja inmutable', async () => {
      const w = await world();
      const started = expectStatus(
        await post(w.dentist.token, w, '/draft'),
        201,
      ).body.draft;
      expect(started).toMatchObject({
        version: 1,
        revision: 0,
        etag: '1.0',
        state: 'DRAFT',
        stateLabel: 'Borrador',
        kind: 'CREATED',
        dentition: 'PERMANENT',
        contentHidden: false,
      });
      expect(started.data).toEqual({
        schema: 'apidental.odontogram',
        schemaVersion: 1,
        teeth: {},
      });
      expect(started.formatNotice).toMatch(/Formato clínico por validar/);

      const data1 = doc(
        {
          '16': {
            surfaces: {
              O: { state: 'CARIES', note: 'ejemplo' },
              M: { state: 'RESTORATION' },
            },
          },
          '36': { status: 'ABSENT' },
          '46': { marks: ['CROWN', 'ENDODONTIC'] },
        },
        'Notas generales de ejemplo',
      );
      const s1 = expectStatus(
        await put(w.dentist.token, w, {
          data: data1,
          expectedEtag: started.etag,
        }),
        200,
      ).body.draft;
      expect(s1).toMatchObject({ etag: '1.1', revision: 1 });
      // guardar lo mismo (aunque llegue desordenado o con valores por defecto) no cambia nada
      const same = expectStatus(
        await put(w.dentist.token, w, {
          data: doc(
            {
              '46': { marks: ['ENDODONTIC', 'CROWN'] },
              '36': { status: 'ABSENT' },
              '16': {
                surfaces: {
                  M: { state: 'RESTORATION' },
                  O: { note: 'ejemplo', state: 'CARIES' },
                },
              },
              '21': { status: 'PRESENT' },
            },
            'Notas generales de ejemplo',
          ),
          expectedEtag: s1.etag,
        }),
        200,
      ).body.draft;
      expect(same.etag).toBe('1.1');
      const stale = await put(w.dentist.token, w, {
        data: data1,
        expectedEtag: '1.0',
      }).expect(409);
      expect(stale.body).toMatchObject({
        code: 'VERSION_CONFLICT',
        currentEtag: '1.1',
      });

      const closed = expectStatus(
        await post(w.dentist.token, w, '/close', { expectedEtag: s1.etag }),
        200,
      ).body;
      expect(closed.odontogram).toMatchObject({
        version: 2,
        state: 'CLOSED',
        stateLabel: 'Guardada',
        kind: 'CREATED',
        etag: '2.0',
      });
      expect(closed.odontogram.closure).toMatchObject({ isSignature: false });
      expect(closed.odontogram.closure.integrityHash).toMatch(/^[0-9a-f]{64}$/);
      expect(closed.reauth).toMatchObject({
        required: false,
        isSignature: false,
      });
      const r = await rows(w.patientId);
      expect(r.map((x) => [x.version, x.status, x.currentKey])).toEqual([
        [1, 'DRAFT', null],
        [2, 'CLOSED', w.patientId],
      ]);
      expect(r[1]!.supersedesId).toBe(r[0]!.id);

      const state = (await get(w.dentist.token, w).expect(200)).body;
      expect(state.official).toMatchObject({
        version: 2,
        stateLabel: 'Guardada',
      });
      expect(state.official.data.teeth['16'].surfaces.O).toEqual({
        state: 'CARIES',
        note: 'ejemplo',
      });
      expect(state.draft).toBeNull();
      // una versión guardada no se sobrescribe: ni por la API ni por la base de datos
      expect(
        (
          await put(w.dentist.token, w, {
            data: doc(),
            expectedEtag: '2.0',
          }).expect(409)
        ).body.code,
      ).toBe('NO_DRAFT');
      const sql = (q: string, ...a: unknown[]) =>
        ctx.db.$executeRawUnsafe(q, ...a);
      await expect(
        sql(
          "UPDATE clinical_odontograms SET data = '{}' WHERE id = ?",
          r[1]!.id,
        ),
      ).rejects.toThrow(/no se edita|inmutable/);
      await expect(
        sql(
          "UPDATE clinical_odontograms SET data = '{}' WHERE id = ?",
          r[0]!.id,
        ),
      ).rejects.toThrow(/no se edita|inmutable/);
      await expect(
        sql(
          "UPDATE clinical_odontograms SET content_hash = REPEAT('a', 64) WHERE id = ?",
          r[1]!.id,
        ),
      ).rejects.toThrow(/inmutable/);
      await expect(
        sql('DELETE FROM clinical_odontograms WHERE id = ?', r[1]!.id),
      ).rejects.toThrow(/no se eliminan/);
      await expect(
        sql(
          'UPDATE clinical_odontograms SET current_key = patient_id WHERE id = ?',
          r[0]!.id,
        ),
      ).rejects.toThrow();
    });

    it('actualizar abre un borrador nuevo sobre la última versión guardada; la guardada queda intacta; un solo borrador a la vez', async () => {
      const w = await world();
      const v2 = await saved(w, {
        '16': { surfaces: { O: { state: 'CARIES' } } },
      });
      const d = expectStatus(
        await post(w.dentist.token, w, '/draft', { purpose: 'UPDATE' }),
        201,
      ).body.draft;
      expect(d).toMatchObject({ version: 3, kind: 'UPDATED', state: 'DRAFT' });
      expect(d.data.teeth['16']).toBeDefined(); // copia de la versión guardada
      const dup = await post(w.dentist.token, w, '/draft').expect(409);
      expect(dup.body).toMatchObject({
        code: 'DRAFT_EXISTS',
        currentEtag: '3.0',
      });
      expect(
        (await get(w.dentist.token, w).expect(200)).body.official.version,
      ).toBe(v2.version); // la vigente sigue siendo la guardada
      await put(w.dentist.token, w, {
        data: doc({ '16': { surfaces: { O: { state: 'RESTORATION' } } } }),
        expectedEtag: d.etag,
      }).expect(200);
      const s = expectStatus(
        await post(w.dentist.token, w, '/close', { expectedEtag: '3.1' }),
        200,
      ).body.odontogram;
      expect(s).toMatchObject({
        version: 4,
        kind: 'UPDATED',
        stateLabel: 'Guardada',
      });
      const all = await rows(w.patientId);
      expect(all.map((x) => x.version)).toEqual([1, 2, 3, 4]);
      expect(
        (
          all[1]!.data as {
            teeth: Record<string, { surfaces: { O: { state: string } } }>;
          }
        ).teeth['16']!.surfaces.O.state,
      ).toBe('CARIES'); // la v2 no cambió
      expect(all.filter((x) => x.currentKey)).toHaveLength(1);
      const versions = (await get(w.dentist.token, w, '/versions').expect(200))
        .body.versions;
      expect(versions.map((v: { version: number }) => v.version)).toEqual([
        4, 3, 2, 1,
      ]);
    });

    it('validación estricta de la estructura: piezas, superficies, estados y combinaciones; los errores no repiten lo enviado', async () => {
      const w = await world();
      const d = expectStatus(await post(w.dentist.token, w, '/draft'), 201).body
        .draft;
      const secret = uniq('SECRETO-');
      const bad: unknown[] = [
        doc({ '99': {} }),
        doc({ '16': { status: 'EXPLODED' } }),
        doc({ '16': { surfaces: { X: { state: 'CARIES' } } } }),
        doc({ '16': { surfaces: { O: { state: 'SE_RECOMIENDA_EXTRAER' } } } }),
        doc({ '16': { marks: ['CROWN', 'CROWN'] } }),
        doc({ '16': { marks: ['MAGIA'] } }),
        doc({
          '36': { status: 'ABSENT', surfaces: { O: { state: 'CARIES' } } },
        }),
        doc({ '36': { status: 'UNERUPTED', marks: ['CROWN'] } }),
        doc({ '55': {} }), // temporal en dentición permanente
        { ...doc(), extra: secret },
        { ...doc(), schemaVersion: 2 },
        { schema: 'otro', schemaVersion: 1, teeth: {} },
        doc({ '16': { note: 'a'.repeat(201) } }),
        doc({
          '16': { surfaces: { O: { state: 'CARIES', note: 'a'.repeat(201) } } },
        }),
        doc({}, 'a'.repeat(1001)),
        doc({ '16': { diagnosis: secret } }),
        doc({
          '16': { surfaces: { O: { state: 'CARIES', treatment: secret } } },
        }),
        { schema: 'apidental.odontogram', schemaVersion: 1, teeth: [] },
        'texto',
      ];
      for (const data of bad) {
        const res = await put(w.dentist.token, w, {
          data,
          expectedEtag: d.etag,
        });
        expect(res.status, JSON.stringify(data)).toBe(400);
        expect(res.text).not.toContain(secret);
      }
      await put(w.dentist.token, w, { expectedEtag: d.etag }).expect(400);
      await put(w.dentist.token, w, { data: doc(), expectedEtag: 'x' }).expect(
        400,
      );
      // una pieza temporal sí vale con dentición temporal o mixta
      await put(w.dentist.token, w, {
        data: doc({ '55': { surfaces: { O: { state: 'SEALANT' } } } }),
        dentition: 'PRIMARY',
        expectedEtag: d.etag,
      }).expect(200);
      await put(w.dentist.token, w, {
        data: doc({ '55': {}, '16': { status: 'IMPLANT' } }),
        dentition: 'MIXED',
        expectedEtag: '1.1',
      }).expect(200);
      expect((await rows(w.patientId)).at(-1)!.revision).toBe(2);
    });

    it('corregir y rectificar: motivo obligatorio y reautenticación al guardar; versión nueva enlazada; la anterior queda intacta (estado Corregida)', async () => {
      const w = await world();
      await saved(w, { '16': { surfaces: { O: { state: 'CARIES' } } } });
      await post(w.dentist.token, w, '/draft', {
        purpose: 'CORRECTION',
      }).expect(400); // sin motivo
      await post(w.dentist.token, w, '/draft', {
        purpose: 'CORRECTION',
        reason: 'ab',
      }).expect(400);
      const d = await correctionDraft(
        w,
        'CORRECTION',
        'Error de registro en la pieza 16',
      );
      expect(d).toMatchObject({ version: 3 });
      const s = expectStatus(
        await put(w.dentist.token, w, {
          data: doc({ '26': { surfaces: { O: { state: 'CARIES' } } } }),
          expectedEtag: d.etag,
        }),
        200,
      ).body.draft;
      // sin reautenticación no se guarda; contraseña incorrecta; prueba ajena; ambas
      await post(w.dentist.token, w, '/close', { expectedEtag: s.etag }).expect(
        400,
      );
      await post(w.dentist.token, w, '/close', {
        expectedEtag: s.etag,
        password: 'Incorrecta-12345',
      }).expect(401);
      const wrongTarget = await reauthProofFor(
        ctx,
        w.dentist.token,
        'CORRECT_ODONTOGRAM',
        GHOST,
      );
      expect(
        (
          await post(w.dentist.token, w, '/close', {
            expectedEtag: s.etag,
            reauthToken: wrongTarget,
          }).expect(403)
        ).body.code,
      ).toBe('REAUTHENTICATION_REQUIRED');
      const wrongPurpose = await reauthProofFor(
        ctx,
        w.dentist.token,
        'CORRECT_CLINICAL_NOTE',
        w.patientId,
      );
      await post(w.dentist.token, w, '/close', {
        expectedEtag: s.etag,
        reauthToken: wrongPurpose,
      }).expect(403);
      await post(w.dentist.token, w, '/close', {
        expectedEtag: s.etag,
        password: PASSWORD,
        reauthToken: 'x'.repeat(20),
      }).expect(400);
      expect((await rows(w.patientId)).at(-1)).toMatchObject({
        status: 'DRAFT',
      });

      const ok = expectStatus(
        await post(w.dentist.token, w, '/close', {
          expectedEtag: s.etag,
          password: PASSWORD,
        }),
        200,
      ).body;
      expect(ok.odontogram).toMatchObject({
        version: 4,
        state: 'CORRECTED',
        stateLabel: 'Corregida',
        kind: 'CORRECTED',
        kindLabel: 'Corrección',
        lastChange: { reason: 'Error de registro en la pieza 16' },
      });
      expect(ok.reauth).toMatchObject({ required: true, isSignature: false });
      expect(ok.reauth.notice).toMatch(
        /No es una firma digital, legal ni clínica/,
      );
      const all = await rows(w.patientId);
      expect(all.map((x) => [x.version, x.status, x.changeKind])).toEqual([
        [1, 'DRAFT', 'CREATED'],
        [2, 'CLOSED', 'CREATED'],
        [3, 'DRAFT', 'CORRECTED'],
        [4, 'CLOSED', 'CORRECTED'],
      ]);
      expect(all[3]!.reauthProofId).toBeTruthy();
      expect(all[3]!.supersedesId).toBe(all[2]!.id);
      expect(
        (all[1]!.data as { teeth: Record<string, unknown> }).teeth['16'],
      ).toBeDefined(); // la guardada original no cambió
      expect(all[3]!.contentHash).not.toBe(all[1]!.contentHash);
      expect(
        await ctx.db.auditLog.count({
          where: { userId: w.dentist.user.id, action: 'REAUTH_CONSUMED' },
        }),
      ).toBe(1);
      const rejected = (
        await ctx.db.auditLog.findMany({
          where: { userId: w.dentist.user.id, action: 'REAUTH_REJECTED' },
        })
      )
        .map((l) => (l.summary as { reason: string }).reason)
        .sort((a, b) => a.localeCompare(b));
      expect(rejected).toEqual(['other_purpose', 'other_target']);

      // rectificación: lo mismo con otro tipo
      const r = await correctionDraft(
        w,
        'RECTIFICATION',
        'El paciente aclaró un dato',
      );
      const rc = expectStatus(
        await post(w.dentist.token, w, '/close', {
          expectedEtag: r.etag,
          password: PASSWORD,
        }),
        200,
      ).body.odontogram;
      expect(rc).toMatchObject({
        version: 6,
        kind: 'RECTIFIED',
        kindLabel: 'Rectificación',
        state: 'CORRECTED',
      });
    });

    it('descartar un borrador (con motivo) lo conserva y no afecta lo guardado; luego se puede empezar otro', async () => {
      const w = await world();
      await saved(w);
      const d = expectStatus(await post(w.dentist.token, w, '/draft'), 201).body
        .draft;
      await post(w.dentist.token, w, '/discard', {
        expectedEtag: d.etag,
      }).expect(400);
      const x = expectStatus(
        await post(w.dentist.token, w, '/discard', {
          expectedEtag: d.etag,
          reason: 'Se empieza de nuevo',
        }),
        200,
      ).body.odontogram;
      expect(x).toMatchObject({
        state: 'DISCARDED',
        stateLabel: 'Descartada',
        version: 4,
      });
      const st = (await get(w.dentist.token, w).expect(200)).body;
      expect(st.draft).toBeNull();
      expect(st.official.version).toBe(2);
      await post(w.dentist.token, w, '/discard', {
        expectedEtag: '4.0',
        reason: 'Otra vez',
      }).expect(409);
      expect(
        (await post(w.dentist.token, w, '/draft').expect(201)).body.draft
          .version,
      ).toBe(5);
    });

    it('registrar por error una versión guardada exige motivo y reautenticación; vuelve a regir la guardada anterior; no se exporta', async () => {
      const w = await world();
      await saved(w, { '16': { surfaces: { O: { state: 'CARIES' } } } });
      const d = await correctionDraft(w, 'RECTIFICATION', 'Ajuste de ejemplo');
      await put(w.dentist.token, w, {
        data: doc({ '26': { status: 'ABSENT' } }),
        expectedEtag: d.etag,
      }).expect(200);
      const v4 = expectStatus(
        await post(w.dentist.token, w, '/close', {
          expectedEtag: '3.1',
          password: PASSWORD,
        }),
        200,
      ).body.odontogram;
      expect(v4.version).toBe(4);
      await post(w.dentist.token, w, '/mark-error', {
        expectedEtag: v4.etag,
        password: PASSWORD,
      }).expect(400); // sin motivo
      await post(w.dentist.token, w, '/mark-error', {
        expectedEtag: v4.etag,
        reason: 'Sin contraseña',
      }).expect(400);
      await post(w.dentist.token, w, '/mark-error', {
        expectedEtag: v4.etag,
        reason: 'Contraseña mal',
        password: 'Incorrecta-12345',
      }).expect(401);
      const e = expectStatus(
        await post(w.dentist.token, w, '/mark-error', {
          expectedEtag: v4.etag,
          reason: 'Paciente equivocado',
          password: PASSWORD,
        }),
        200,
      ).body.odontogram;
      expect(e).toMatchObject({
        state: 'ENTERED_IN_ERROR',
        stateLabel: 'Registrada por error',
        version: 5,
      });
      const st = (await get(w.dentist.token, w).expect(200)).body;
      expect(st.official.version).toBe(2); // vuelve a regir la anterior guardada
      await exp(w.dentist.token, w, '?version=4').expect(409);
      expect(
        (await exp(w.dentist.token, w).expect(200)).headers[
          'content-disposition'
        ],
      ).toMatch(/odontograma-v2-/);
      expect((await rows(w.patientId)).length).toBe(5);
      // con un borrador abierto no se registra por error
      const d2 = expectStatus(await post(w.dentist.token, w, '/draft'), 201)
        .body.draft;
      await post(w.dentist.token, w, '/mark-error', {
        expectedEtag: d2.etag,
        reason: 'No procede',
        password: PASSWORD,
      }).expect(409);
    });

    it('la base de datos impone transiciones, motivos y reautenticación aunque se salte la API', async () => {
      const w = await world();
      await saved(w);
      const [v1, v2] = await rows(w.patientId);
      const base = {
        clinicId: w.clinic.id,
        patientId: w.patientId,
        dentition: 'PERMANENT' as const,
        data: JSON.parse(JSON.stringify(doc())) as never,
        createdById: w.dentist.user.id,
        currentKey: w.patientId,
      };
      await ctx.db.clinicalOdontogram.update({
        where: { id: v2!.id },
        data: { currentKey: null },
      });
      // guardada -> guardada, borrador sin tipo válido, error sin reautenticación, corrección sin motivo
      await expect(
        ctx.db.clinicalOdontogram.create({
          data: {
            ...base,
            version: 3,
            supersedesId: v2!.id,
            status: 'CLOSED',
            changeKind: 'UPDATED',
            contentHash: 'a'.repeat(64),
            closedAt: new Date(),
          },
        }),
      ).rejects.toThrow(/transición/);
      await expect(
        ctx.db.clinicalOdontogram.create({
          data: {
            ...base,
            version: 3,
            supersedesId: v2!.id,
            status: 'DRAFT',
            changeKind: 'CREATED',
          },
        }),
      ).rejects.toThrow(/actualización, corrección o rectificación|reemplazan/);
      await expect(
        ctx.db.clinicalOdontogram.create({
          data: {
            ...base,
            version: 3,
            supersedesId: v2!.id,
            status: 'ENTERED_IN_ERROR',
            changeKind: 'MARKED_IN_ERROR',
            changeReason: 'Motivo válido',
          },
        }),
      ).rejects.toThrow(/reautenticación/);
      await expect(
        ctx.db.clinicalOdontogram.create({
          data: {
            ...base,
            version: 3,
            supersedesId: v2!.id,
            status: 'DRAFT',
            changeKind: 'CORRECTED',
          },
        }),
      ).rejects.toThrow(/motivo/);
      await expect(
        ctx.db.clinicalOdontogram.create({
          data: {
            ...base,
            version: 5,
            supersedesId: v2!.id,
            status: 'DRAFT',
            changeKind: 'UPDATED',
          },
        }),
      ).rejects.toThrow(/continuar/);
      // un borrador de corrección guardado sin reautenticación ni huella
      const draft = await ctx.db.clinicalOdontogram.create({
        data: {
          ...base,
          version: 3,
          supersedesId: v2!.id,
          status: 'DRAFT',
          changeKind: 'CORRECTED',
          changeReason: 'Motivo válido',
        },
      });
      await ctx.db.clinicalOdontogram.update({
        where: { id: draft.id },
        data: { currentKey: null },
      });
      await expect(
        ctx.db.clinicalOdontogram.create({
          data: {
            ...base,
            version: 4,
            supersedesId: draft.id,
            status: 'CLOSED',
            changeKind: 'CORRECTED',
            changeReason: 'Motivo válido',
            contentHash: 'a'.repeat(64),
            closedAt: new Date(),
          },
        }),
      ).rejects.toThrow(/reautenticación/);
      await expect(
        ctx.db.clinicalOdontogram.create({
          data: {
            ...base,
            version: 4,
            supersedesId: draft.id,
            status: 'CLOSED',
            changeKind: 'CORRECTED',
            changeReason: 'Motivo válido',
            reauthProofId: GHOST,
          },
        }),
      ).rejects.toThrow(/huella/);
      await expect(
        ctx.db.clinicalOdontogram.create({
          data: {
            ...base,
            version: 4,
            supersedesId: draft.id,
            status: 'CLOSED',
            changeKind: 'UPDATED',
            changeReason: 'Motivo válido',
            reauthProofId: GHOST,
            contentHash: 'a'.repeat(64),
            closedAt: new Date(),
          },
        }),
      ).rejects.toThrow(/conserva el tipo/);
      expect(v1).toBeTruthy();
      // otra clínica: FK compuesta
      await expect(
        ctx.db.clinicalOdontogram.create({
          data: {
            ...base,
            clinicId: (await fx.clinic()).id,
            version: 1,
            status: 'DRAFT',
            changeKind: 'CREATED',
            patientId: w.patientId,
            currentKey: w.patientId,
          },
        }),
      ).rejects.toThrow();
    });
  });

  describe('quién accede', () => {
    it('otro odontólogo con relación lee lo guardado pero no ve ni toca el borrador ajeno; solo desde la sede de origen se escribe', async () => {
      const w = await world();
      await saved(w, { '16': { surfaces: { O: { state: 'CARIES' } } } });
      const colleague = await fx.userWithRole('DENTIST', {
        clinicId: w.clinic.id,
        branchId: w.branchA.id,
      });
      await assignCare(ctx, w.reception.token, w.patientId, colleague.user.id);
      const cTok = await loginInContext(ctx, colleague.user.email, {
        clinicId: w.clinic.id,
        branchId: w.branchA.id,
      });
      expect(
        (await get(cTok, w).expect(200)).body.official.data.teeth['16'],
      ).toBeDefined();
      const d = expectStatus(await post(w.dentist.token, w, '/draft'), 201).body
        .draft;
      await put(w.dentist.token, w, {
        data: doc({ '11': { marks: ['CROWN'] } }),
        expectedEtag: d.etag,
      }).expect(200);
      const seen = (await get(cTok, w).expect(200)).body;
      expect(seen.draft).toMatchObject({
        contentHidden: true,
        data: null,
        state: 'DRAFT',
      });
      expect(seen.draftIsMine).toBe(false);
      expect(
        (await put(cTok, w, { data: doc(), expectedEtag: '3.1' }).expect(403))
          .body.code,
      ).toBe('NOT_DRAFT_AUTHOR');
      await post(cTok, w, '/close', { expectedEtag: '3.1' }).expect(403);
      await post(cTok, w, '/discard', {
        expectedEtag: '3.1',
        reason: 'No es mío',
      }).expect(403);
      await post(cTok, w, '/draft').expect(409); // ya hay un borrador abierto
      // el autor sigue editando su borrador desde otra sede (la relación es de toda la clínica)
      await put(w.dentist.tokenB, w, {
        data: doc({ '11': { marks: ['CROWN'] } }),
        expectedEtag: '3.1',
      }).expect(200);
      expect(
        (await get(w.dentist.tokenB, w).expect(200)).body.draftIsMine,
      ).toBe(true);
    });

    it('relación de una sede: se lee desde cualquier sede, pero abrir o guardar solo desde la sede de origen', async () => {
      const w = await world();
      const p2 = (await createPatient(ctx, w.reception.token)).id;
      await assignCare(ctx, w.reception.token, p2, w.dentist.user.id, {
        branchId: w.branchB.id,
      });
      const w2 = { ...w, patientId: p2 } as W;
      await get(w.dentist.token, w2).expect(200);
      expect(
        (await post(w.dentist.token, w2, '/draft').expect(403)).body.code,
      ).toBe('WRONG_BRANCH');
      const d = expectStatus(await post(w.dentist.tokenB, w2, '/draft'), 201)
        .body.draft;
      expect(
        (
          await put(w.dentist.token, w2, {
            data: doc(),
            expectedEtag: d.etag,
          }).expect(403)
        ).body.code,
      ).toBe('WRONG_BRANCH');
      await put(w.dentist.tokenB, w2, {
        data: doc({ '11': {} }),
        expectedEtag: d.etag,
      }).expect(200);
    });

    it('asistente, recepción, caja, administración y plataforma: sin acceso al detalle; mismo 403 exista o no el paciente', async () => {
      const w = await world();
      await saved(w);
      const { user } = await fx.userWithRole('PLATFORM_ADMIN');
      const platform = await loginInContext(ctx, user.email);
      expect((await get(w.assistant.token, w).expect(403)).body.code).toBe(
        'CLINICAL_LIMITED_VIEW',
      );
      for (const p of ['', '/versions', '/export'])
        await get(w.reception.token, w, p).expect(200);
      await post(w.reception.token, w, '/draft').expect(403);
      await put(w.reception.token, w, { data: doc(), expectedEtag: '1.0' }).expect(403);
      for (const p of ['/versions', '/export'])
        expect((await get(w.assistant.token, w, p).expect(403)).body.code).toBe(
          'CLINICAL_LIMITED_VIEW',
        );
      await post(w.assistant.token, w, '/draft').expect(403);
      for (const t of [
        platform,
        w.admin.token,
        w.cashier.token,
      ]) {
        for (const p of ['', '/versions', '/export']) {
          const real = await get(t, w, p).expect(403);
          const ghost = await ctx
            .http()
            .get(`/v1/patients/${GHOST}/clinical/odontogram${p}`)
            .set(bearer(t))
            .expect(403);
          expect(real.body.message).toBe(ghost.body.message);
        }
        await post(t, w, '/draft').expect(403);
        await put(t, w, { data: doc(), expectedEtag: '1.0' }).expect(403);
      }
    });

    it('Director: sin autorización no lee ni exporta; con ella solo lee y exporta; nunca escribe; el borrador sigue oculto', async () => {
      const w = await world();
      await saved(w, { '16': { surfaces: { O: { state: 'CARIES' } } } });
      const d = expectStatus(await post(w.dentist.token, w, '/draft'), 201).body
        .draft;
      for (const p of ['', '/versions', '/export'])
        expect((await get(w.director.token, w, p).expect(403)).body.code).toBe(
          'CLINICAL_JUSTIFICATION_REQUIRED',
        );
      expectStatus(await grantReadAll(ctx, w.director.token, w.patientId), 201);
      const st = (await get(w.director.token, w).expect(200)).body;
      expect(st.official.data.teeth['16']).toBeDefined();
      expect(st.draft).toMatchObject({ contentHidden: true, data: null });
      await get(w.director.token, w, '/versions').expect(200);
      expect(
        (await exp(w.director.token, w).expect(200)).body
          .subarray(0, 5)
          .toString(),
      ).toBe('%PDF-');
      await post(w.director.token, w, '/draft').expect(403);
      await put(w.director.token, w, {
        data: doc(),
        expectedEtag: d.etag,
      }).expect(403);
      await post(w.director.token, w, '/close', {
        expectedEtag: d.etag,
      }).expect(403);
      await post(w.director.token, w, '/mark-error', {
        expectedEtag: d.etag,
        reason: 'No debe',
        password: PASSWORD,
      }).expect(403);
      const reads = await ctx.db.auditLog.findMany({
        where: { patientId: w.patientId, action: 'CLINICAL_READ_ALL_READ' },
      });
      expect(
        reads
          .map((r) => (r.summary as { sections: string[] }).sections[0])
          .sort((a, b) => String(a).localeCompare(String(b))),
      ).toEqual(['odontogram', 'odontogram_export', 'odontogram_versions']);
    });

    it('otra clínica: 404 idéntico al inexistente (lectura, versiones, exportación y escritura); sin relación o con relación revocada: 403', async () => {
      const w = await world();
      await saved(w);
      const other = await fx.clinic();
      const dentistB = await actorIn(ctx, fx, 'DENTIST', {
        clinicId: other.id,
        branchId: (await fx.branch(other.id)).id,
      });
      for (const p of ['', '/versions', '/export']) {
        const foreign = await get(dentistB.token, w, p).expect(404);
        const ghost = await ctx
          .http()
          .get(`/v1/patients/${GHOST}/clinical/odontogram${p}`)
          .set(bearer(dentistB.token))
          .expect(404);
        expect(foreign.body.message).toBe(ghost.body.message);
      }
      await post(dentistB.token, w, '/draft').expect(404);
      await put(dentistB.token, w, { data: doc(), expectedEtag: '1.0' }).expect(
        404,
      );
      await post(dentistB.token, w, '/mark-error', {
        expectedEtag: '2.0',
        reason: 'Ajeno',
        password: PASSWORD,
      }).expect(404);
      const rows404 = await ctx.db.auditLog.findMany({
        where: { userId: dentistB.user.id, action: 'CLINICAL_ACCESS_DENIED' },
      });
      expect(rows404.length).toBeGreaterThanOrEqual(5);
      for (const r of rows404) {
        expect(r.patientId).toBeNull();
        expect(JSON.stringify(r)).not.toContain(w.patientId);
      }
      const stranger = await actorIn(ctx, fx, 'DENTIST', {
        clinicId: w.clinic.id,
        branchId: w.branchA.id,
      });
      expect((await get(stranger.token, w).expect(403)).body.code).toBe(
        'NO_CARE_RELATIONSHIP',
      );
      await post(stranger.token, w, '/draft').expect(403);
      await revokeCareReq(ctx, w.reception.token, w.rel.id).expect(200);
      for (const p of ['', '/versions', '/export'])
        expect((await get(w.dentist.token, w, p).expect(403)).body.code).toBe(
          'NO_CARE_RELATIONSHIP',
        );
      await post(w.dentist.token, w, '/draft').expect(403);
    });
  });

  describe('exportación', () => {
    it('PDF autorizado: identidad de la clínica y del paciente, fecha, profesional, versión, aviso "formato clínico por validar" y detalle en texto', async () => {
      const w = await world();
      await saved(
        w,
        {
          '16': {
            surfaces: { O: { state: 'CARIES', note: 'nota de ejemplo' } },
          },
          '36': { status: 'ABSENT' },
        },
        'Notas generales de ejemplo',
      );
      const res = expectStatus(await exp(w.dentist.token, w), 200);
      expect(res.headers['content-type']).toMatch(/application\/pdf/);
      expect(res.headers['content-disposition']).toMatch(
        /^attachment; filename="odontograma-v2-\d{4}-\d{2}-\d{2}\.pdf"$/,
      );
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      const pdf = res.body as Buffer;
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
      const text = pdfText(pdf);
      const patient = await ctx.db.patient.findUniqueOrThrow({
        where: { id: w.patientId },
      });
      expect(res.headers['content-disposition']).not.toContain(
        patient.lastName,
      ); // el nombre del archivo no lleva datos personales
      for (const must of [
        'Demo \\(prueba\\)',
        patient.lastName,
        'POR VALIDAR',
        'MINSA',
        'Versi',
        'Profesional',
        'Fecha de la versi',
        'Pieza 16',
        'Caries \\(nota de ejemplo\\)',
        'Notas generales de ejemplo',
        'firma digital',
      ])
        expect(text, must).toMatch(new RegExp(must));
      expect(text).toMatch(/DNI 900\d{5}/);
      // El único lugar donde aparecen esas palabras es el aviso de que NO se incluyen.
      const withoutDisclaimer = text.replace(
        /no incluye recomendaciones, tratamientos ni presupuestos/gi,
        '',
      );
      for (const never of [
        /recomend/i,
        /presupuesto/i,
        /tratamiento sugerido/i,
        /plan de tratamiento/i,
      ])
        expect(withoutDisclaimer).not.toMatch(never);
      expect(text).toMatch(
        /no incluye recomendaciones, tratamientos ni presupuestos/i,
      );
      expect(res.headers['content-length']).toBe(String(pdf.length));
    });

    it('SVG: documento autónomo, accesible y seguro; el texto del usuario va escapado', async () => {
      const w = await world();
      await saved(
        w,
        {
          '16': {
            surfaces: {
              O: { state: 'CARIES', note: '<script>alert(1)</script>' },
            },
          },
        },
        '"><img src=x onerror=alert(1)>',
      );
      const res = expectStatus(
        await exp(w.dentist.token, w, '?format=svg'),
        200,
      );
      expect(res.headers['content-type']).toMatch(/image\/svg\+xml/);
      const svg = (res.body as Buffer).toString('utf8');
      expect(svg).toMatch(/^<svg /);
      expect(svg).toContain('id="tooth-16"');
      expect(svg).toContain('role="img"');
      expect(svg).toContain('Formato clínico por validar');
      expect(svg).not.toMatch(/<script|onerror|<img/i);
    });

    it('la exportación se audita ANTES de entregar (versión y formato, sin contenido); si falla la auditoría, no se entrega; pedir un borrador o algo inexistente falla', async () => {
      const w = await world();
      await exp(w.dentist.token, w).expect(404); // aún no hay versión guardada
      await saved(w, {
        '16': { surfaces: { O: { state: 'CARIES', note: uniq('NOTA-') } } },
      });
      const d = expectStatus(await post(w.dentist.token, w, '/draft'), 201).body
        .draft;
      await exp(w.dentist.token, w, '?version=3').expect(409); // borrador
      await exp(w.dentist.token, w, '?version=99').expect(404);
      await exp(w.dentist.token, w, '?format=docx').expect(400);
      await exp(w.dentist.token, w, '?version=0').expect(400);
      expect(d.version).toBe(3);
      await exp(w.dentist.token, w).expect(200);
      await exp(w.dentist.token, w, '?format=svg&version=2').expect(200);
      const logs = await ctx.db.auditLog.findMany({
        where: {
          patientId: w.patientId,
          action: 'CLINICAL_ODONTOGRAM_EXPORTED',
        },
        orderBy: { createdAt: 'asc' },
      });
      expect(logs.map((l) => l.summary)).toEqual([
        { version: 2, format: 'pdf', via: 'care_relationship' },
        { version: 2, format: 'svg', via: 'care_relationship' },
      ]);
      expect(logs[0]).toMatchObject({
        userId: w.dentist.user.id,
        clinicId: w.clinic.id,
      });
      expect(logs[0]!.ip).toBeTruthy();
      // falla cerrada
      const audit = ctx.app.get(AuditService);
      const original = audit.record.bind(audit);
      vi.spyOn(audit, 'record').mockImplementation(async (entry, tx) => {
        if (entry.action === 'CLINICAL_ODONTOGRAM_EXPORTED')
          throw new Error('auditoría caída');
        return original(entry, tx);
      });
      const failed = await exp(w.dentist.token, w);
      expect(failed.status).toBe(503);
      expect((failed.body as Buffer).subarray(0, 4).toString()).not.toBe(
        '%PDF',
      );
    });
  });

  describe('auditoría y datos sin contenido clínico', () => {
    it('ni la auditoría, ni los listados, ni los errores, ni los logs contienen el contenido del odontograma, las notas ni los motivos', async () => {
      const w = await world();
      const marker = uniq('ODONTO-');
      await saved(
        w,
        {
          '16': {
            surfaces: { O: { state: 'CARIES', note: `${marker}-sup` } },
            note: `${marker}-pieza`,
          },
        },
        `${marker}-general`,
      );
      const d = await correctionDraft(w, 'CORRECTION', `${marker}-motivo`);
      await put(w.dentist.token, w, {
        data: doc({ '26': { note: `${marker}-v3` } }, `${marker}-g3`),
        expectedEtag: d.etag,
      }).expect(200);
      await put(w.dentist.token, w, {
        data: doc({ '99': { note: `${marker}-malo` } }),
        expectedEtag: '3.1',
      }).expect(400);
      await put(w.dentist.token, w, {
        data: doc(),
        expectedEtag: '3.0',
      }).expect(409);
      await post(w.dentist.token, w, '/close', {
        expectedEtag: '3.1',
        password: PASSWORD,
      }).expect(200);
      await post(w.dentist.token, w, '/mark-error', {
        expectedEtag: '4.0',
        password: 'Incorrecta-12345',
        reason: `${marker}-err`,
      }).expect(401);
      await exp(w.dentist.token, w).expect(200);
      expectStatus(await grantReadAll(ctx, w.director.token, w.patientId), 201);
      await get(w.director.token, w).expect(200);

      const dump = JSON.stringify(await ctx.db.auditLog.findMany({}));
      expect(dump).not.toContain(marker);
      expect(dump).not.toContain(PASSWORD);
      for (const q of [
        '',
        '?action=CLINICAL_ODONTOGRAM_CLOSED',
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
        await get(w.assistant.token, w),
        await get(w.dentist.token, { ...w, patientId: GHOST } as W),
      ];
      for (const r of responses) expect(r.text).not.toContain(marker);
      expect(logger.lines.join('\n')).not.toContain(marker);
      expect(logger.lines.join('\n')).not.toContain(PASSWORD);
      // los eventos quedan con referencias, versión y campos
      const closed = await ctx.db.auditLog.findFirstOrThrow({
        where: { patientId: w.patientId, action: 'CLINICAL_ODONTOGRAM_CLOSED' },
        orderBy: { createdAt: 'desc' },
      });
      expect(closed.summary).toMatchObject({
        version: 4,
        changeKind: 'CORRECTED',
        fields: ['data'],
        reauthenticated: true,
        isSignature: false,
      });
    });

    it('falla cerrada: si falla la auditoría la lectura da 503 sin datos y las escrituras se revierten (la prueba de reautenticación no se gasta)', async () => {
      const w = await world();
      await saved(w, { '16': { surfaces: { O: { state: 'CARIES' } } } });
      const d = await correctionDraft(w, 'CORRECTION', 'Motivo de prueba');
      const proof = await reauthProofFor(
        ctx,
        w.dentist.token,
        'CORRECT_ODONTOGRAM',
        w.patientId,
      );
      const audit = ctx.app.get(AuditService);
      const original = audit.record.bind(audit);
      vi.spyOn(audit, 'record').mockImplementation(async (entry, tx) => {
        if (
          entry.action === 'CLINICAL_RECORD_VIEWED' ||
          entry.action.startsWith('CLINICAL_ODONTOGRAM_')
        )
          throw new Error('auditoría caída');
        return original(entry, tx);
      });
      for (const p of ['', '/versions'])
        expect((await get(w.dentist.token, w, p)).status).toBe(503);
      expect(
        (
          await put(w.dentist.token, w, {
            data: doc({ '11': {} }),
            expectedEtag: d.etag,
          })
        ).status,
      ).toBeGreaterThanOrEqual(500);
      expect(
        (
          await post(w.dentist.token, w, '/close', {
            expectedEtag: d.etag,
            reauthToken: proof,
          })
        ).status,
      ).toBeGreaterThanOrEqual(500);
      vi.restoreAllMocks();
      expect((await rows(w.patientId)).at(-1)).toMatchObject({
        version: 3,
        status: 'DRAFT',
        revision: 0,
      });
      expectStatus(
        await post(w.dentist.token, w, '/close', {
          expectedEtag: d.etag,
          reauthToken: proof,
        }),
        200,
      ); // la prueba sigue sirviendo
    });
  });

  describe('ficha de atención', () => {
    it('incluye el resumen del odontograma (sin detalle): versión guardada y si hay borrador propio', async () => {
      const w = await world();
      const visit = expectStatus(
        await ctx
          .http()
          .post(`/v1/patients/${w.patientId}/clinical/visits`)
          .set(bearer(w.dentist.token))
          .send({}),
        201,
      ).body;
      const sheetOf = async () =>
        (
          await ctx
            .http()
            .get(
              `/v1/patients/${w.patientId}/clinical/visits/${visit.id}/sheet`,
            )
            .set(bearer(w.dentist.token))
            .expect(200)
        ).body;
      expect((await sheetOf()).odontogram).toMatchObject({
        savedVersion: null,
        hasDraft: false,
      });
      await saved(w);
      expect((await sheetOf()).odontogram).toMatchObject({
        savedVersion: { version: 2, stateLabel: 'Guardada' },
        hasDraft: false,
      });
      await post(w.dentist.token, w, '/draft').expect(201);
      const s = await sheetOf();
      expect(s.odontogram).toMatchObject({ hasDraft: true, draftIsMine: true });
      expect(JSON.stringify(s.odontogram)).not.toContain('teeth');
    });
  });

  describe('concurrencia', () => {
    const sound = async (patientId: string) => {
      const all = await rows(patientId);
      expect(all.map((r) => r.version)).toEqual(all.map((_, i) => i + 1));
      expect(all.filter((r) => r.currentKey !== null)).toHaveLength(1);
      expect(all.at(-1)!.currentKey).toBe(patientId);
      return all;
    };

    it('abrir borradores simultáneos: uno prospera; guardados simultáneos con el mismo etag: uno prospera', async () => {
      const w = await world();
      const results = await Promise.all(
        Array.from({ length: 5 }, () => post(w.dentist.token, w, '/draft')),
      );
      expect(results.map((r) => r.status).sort((x, y) => x - y)).toEqual([
        201, 409, 409, 409, 409,
      ]);
      const saves = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          put(w.dentist.token, w, {
            data: doc({ '11': { note: `v${i}` } }),
            expectedEtag: '1.0',
          }),
        ),
      );
      expect(saves.map((r) => r.status).sort((x, y) => x - y)).toEqual([
        200, 409, 409, 409, 409,
      ]);
      const all = await sound(w.patientId);
      expect(all).toHaveLength(1);
      expect(all[0]!.revision).toBe(1);
    });

    it('guardar la versión dos veces a la vez, o mientras se edita: una sola versión guardada y coherente con el último contenido guardado', async () => {
      for (let round = 0; round < 4; round++) {
        const w = await world();
        const d = expectStatus(await post(w.dentist.token, w, '/draft'), 201)
          .body.draft;
        const [a, b, s] = await Promise.all([
          post(w.dentist.token, w, '/close', { expectedEtag: d.etag }),
          post(w.dentist.token, w, '/close', { expectedEtag: d.etag }),
          put(w.dentist.token, w, {
            data: doc({ '11': { marks: ['CROWN'] } }),
            expectedEtag: d.etag,
          }),
        ]);
        const closes = [a, b].filter((r) => r.status === 200);
        expect(closes.length, `ronda ${round}`).toBeLessThanOrEqual(1);
        expect(
          [a, b, s].every((r) => [200, 409].includes(r.status)),
          `ronda ${round}`,
        ).toBe(true);
        const all = await sound(w.patientId);
        if (closes.length === 1) {
          expect(all.at(-1)!.status).toBe('CLOSED');
          expect(
            Object.keys((all.at(-1)!.data as { teeth: object }).teeth),
          ).toEqual(s.status === 200 ? ['11'] : []);
          expect(
            await ctx.db.auditLog.count({
              where: {
                patientId: w.patientId,
                action: 'CLINICAL_ODONTOGRAM_CLOSED',
              },
            }),
          ).toBe(1);
        } else {
          expect(s.status).toBe(200);
          expect(all.at(-1)).toMatchObject({ status: 'DRAFT', revision: 1 });
        }
      }
    });

    it('correcciones simultáneas (guardar la versión corregida a la vez): una prospera y la reautenticación solo se gasta una vez', async () => {
      const w = await world();
      await saved(w);
      const d = await correctionDraft(w);
      const proofs = await Promise.all(
        [1, 2, 3].map(() =>
          reauthProofFor(
            ctx,
            w.dentist.token,
            'CORRECT_ODONTOGRAM',
            w.patientId,
          ),
        ),
      );
      const results = await Promise.all(
        proofs.map((p) =>
          post(w.dentist.token, w, '/close', {
            expectedEtag: d.etag,
            reauthToken: p,
          }),
        ),
      );
      expect(results.map((r) => r.status).sort((x, y) => x - y)).toEqual([
        200, 409, 409,
      ]);
      expect(await sound(w.patientId)).toHaveLength(4);
      expect(
        await ctx.db.auditLog.count({
          where: { userId: w.dentist.user.id, action: 'REAUTH_CONSUMED' },
        }),
      ).toBe(1);
    });

    it('descartar y guardar a la vez, o registrar por error dos veces: una sola gana', async () => {
      const w = await world();
      await saved(w);
      const d = expectStatus(await post(w.dentist.token, w, '/draft'), 201).body
        .draft;
      const [c, x] = await Promise.all([
        post(w.dentist.token, w, '/close', { expectedEtag: d.etag }),
        post(w.dentist.token, w, '/discard', {
          expectedEtag: d.etag,
          reason: 'Se descarta',
        }),
      ]);
      expect([c.status, x.status].sort((p, q) => p - q)).toEqual([200, 409]);
      const last = (await sound(w.patientId)).at(-1)!;
      const errs = await Promise.all(
        [1, 2, 3].map(() =>
          post(w.dentist.token, w, '/mark-error', {
            expectedEtag: `${last.version}.0`,
            reason: 'Registro por error',
            password: PASSWORD,
          }),
        ),
      );
      if (last.status === 'CLOSED')
        expect(errs.map((r) => r.status).sort((p, q) => p - q)).toEqual([
          200, 409, 409,
        ]);
      await sound(w.patientId);
    });

    it('revocar la relación, retirar el rol o deshabilitar al odontólogo mientras edita o guarda: nada se escribe tras la baja', async () => {
      for (let round = 0; round < 3; round++) {
        const w = await world();
        const d = expectStatus(await post(w.dentist.token, w, '/draft'), 201)
          .body.draft;
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
        const [offRes, saved1, closed1] = await Promise.all([
          off,
          put(w.dentist.token, w, {
            data: doc({ '11': { marks: ['CROWN'] } }),
            expectedEtag: d.etag,
          }),
          post(w.dentist.token, w, '/close', { expectedEtag: d.etag }),
        ]);
        if (Array.isArray(offRes))
          expect(offRes.every((r) => r.status === 200)).toBe(true);
        else expect((offRes as { status: number }).status).toBe(200);
        for (const r of [saved1, closed1])
          expect([200, 401, 403, 409], `ronda ${round}`).toContain(r.status);
        await sound(w.patientId);
        const after = await put(w.dentist.token, w, {
          data: doc({ '12': {} }),
          expectedEtag: '9.9',
        });
        expect([401, 403, 409]).toContain(after.status);
        const audited = await ctx.db.auditLog.count({
          where: {
            patientId: w.patientId,
            action: {
              in: [
                'CLINICAL_ODONTOGRAM_DRAFT_SAVED',
                'CLINICAL_ODONTOGRAM_CLOSED',
              ],
            },
          },
        });
        expect(audited).toBe(
          [saved1, closed1].filter((r) => r.status === 200).length,
        );
      }
    });
  });
});
