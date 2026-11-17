import {
  actorIn,
  assignCare,
  bearer,
  createPatient,
  createTestContext,
  Fixtures,
  loginInContext,
  PASSWORD,
  type TestContext,
  uniq,
} from './helpers/app.js';

/** Texto de un PDF generado por pdfkit (las cadenas de texto van en hexadecimal dentro de operadores TJ). */
const pdfText = (pdf: Buffer): string =>
  [...pdf.toString('latin1').matchAll(/\[(.*?)\] TJ/g)]
    .map((m) =>
      [...m[1]!.matchAll(/<([0-9a-f]+)>/g)]
        .map((h) => Buffer.from(h[1]!, 'hex').toString('latin1'))
        .join(''),
    )
    .join('\n');
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
const CARIES_16 = { '16': { surfaces: { O: { state: 'CARIES' } } } };
const RESTORED_16 = { '16': { surfaces: { O: { state: 'RESTORATION' } } } };

describe('Odontograma de la visita: diagnóstico y post tratamiento (6.1)', () => {
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
    const reception = await actorIn(ctx, fx, 'RECEPTIONIST', {
      clinicId: clinic.id,
    });
    const mkDentist = async () => {
      const user = await fx.user();
      await fx.assign(user.id, 'DENTIST', {
        clinicId: clinic.id,
        branchId: branch.id,
      });
      return {
        user,
        token: await loginInContext(ctx, user.email, {
          clinicId: clinic.id,
          branchId: branch.id,
        }),
      };
    };
    const dentist = await mkDentist();
    const other = await mkDentist();
    const { id: patientId } = await createPatient(ctx, reception.token, {
      lastName: uniq('Apellido'),
      firstName: 'Rosa',
    });
    await assignCare(ctx, reception.token, patientId, dentist.user.id);
    await assignCare(ctx, reception.token, patientId, other.user.id);
    const visit = expectStatus(
      await ctx
        .http()
        .post(`/v1/patients/${patientId}/clinical/visits`)
        .set(bearer(dentist.token))
        .send({}),
      201,
    ).body as { id: string; version: number };
    return { clinic, branch, reception, dentist, other, patientId, visit };
  }
  type W = Awaited<ReturnType<typeof world>>;

  const base = (w: W) =>
    `/v1/patients/${w.patientId}/clinical/visits/${w.visit.id}`;
  const get = (w: W, t = w.dentist.token) =>
    ctx
      .http()
      .get(`${base(w)}/odontogram`)
      .set(bearer(t));
  const post = (w: W, p: string, b: object = {}, t = w.dentist.token) =>
    ctx
      .http()
      .post(`${base(w)}/odontogram/${p}`)
      .set(bearer(t))
      .send(b);
  const put = (w: W, phase: string, b: object, t = w.dentist.token) =>
    ctx
      .http()
      .put(`${base(w)}/odontogram/${phase}/draft`)
      .set(bearer(t))
      .send(b);
  const closeVisit = (w: W, expectedVersion = 1) =>
    ctx
      .http()
      .post(`${base(w)}/close`)
      .set(bearer(w.dentist.token))
      .send({ expectedVersion });
  const patientChain = (patientId: string) =>
    ctx.db.clinicalOdontogram.findMany({
      where: { patientId },
      orderBy: { version: 'asc' },
    });

  /** Abre, edita y guarda una fase. */
  async function savePhase(
    w: W,
    phase: 'DIAGNOSIS' | 'POST_TREATMENT',
    teeth: Record<string, unknown>,
    notes?: string,
  ) {
    const d = expectStatus(await post(w, `${phase}/draft`), 201).body
      .odontogram;
    const s = expectStatus(
      await put(w, phase, { data: doc(teeth, notes), expectedEtag: d.etag }),
      200,
    ).body.odontogram;
    return expectStatus(
      await post(w, `${phase}/close`, { expectedEtag: s.etag }),
      200,
    ).body.odontogram as { version: number; etag: string; data: unknown };
  }

  /** Odontograma general del paciente guardado (versión 2), hecho desde su propia página. */
  async function patientSaved(w: W, teeth: Record<string, unknown>) {
    const u = `/v1/patients/${w.patientId}/clinical/odontogram`;
    const d = expectStatus(
      await ctx.http().post(`${u}/draft`).set(bearer(w.dentist.token)).send({}),
      201,
    ).body.draft;
    const s = expectStatus(
      await ctx
        .http()
        .put(`${u}/draft`)
        .set(bearer(w.dentist.token))
        .send({ data: doc(teeth), expectedEtag: d.etag }),
      200,
    ).body.draft;
    expectStatus(
      await ctx
        .http()
        .post(`${u}/close`)
        .set(bearer(w.dentist.token))
        .send({ expectedEtag: s.etag }),
      200,
    );
  }

  describe('fases', () => {
    it('el diagnóstico parte del odontograma vigente del paciente; el post tratamiento, del diagnóstico guardado', async () => {
      const w = await world();
      await patientSaved(w, CARIES_16);
      const empty = expectStatus(await get(w), 200).body;
      expect(empty.phases).toEqual({ DIAGNOSIS: null, POST_TREATMENT: null });
      expect(empty.actions).toMatchObject({
        canStartDiagnosis: true,
        canStartPost: false,
      });

      // Post tratamiento sin diagnóstico guardado: no.
      const early = expectStatus(await post(w, 'POST_TREATMENT/draft'), 409);
      expect(early.body.code).toBe('DIAGNOSIS_NOT_SAVED');

      const diag = expectStatus(await post(w, 'DIAGNOSIS/draft'), 201).body
        .odontogram;
      expect(diag).toMatchObject({ phase: 'DIAGNOSIS', state: 'DRAFT' });
      expect(diag.data.teeth).toEqual(CARIES_16);
      expectStatus(
        await post(w, 'DIAGNOSIS/close', { expectedEtag: diag.etag }),
        200,
      );
      // Una fase guardada no se vuelve a abrir: se corrige.
      expect(
        expectStatus(await post(w, 'DIAGNOSIS/draft'), 409).body.code,
      ).toBe('ALREADY_SAVED');

      const post1 = expectStatus(await post(w, 'POST_TREATMENT/draft'), 201)
        .body.odontogram;
      expect(post1.data.teeth).toEqual(CARIES_16);
      const s = expectStatus(
        await put(w, 'POST_TREATMENT', {
          data: doc(RESTORED_16),
          expectedEtag: post1.etag,
        }),
        200,
      ).body.odontogram;
      expect(s.etag).toBe(`${post1.version}.1`);
      // Etag viejo: conflicto.
      expect(
        expectStatus(
          await put(w, 'POST_TREATMENT', {
            data: doc({}),
            expectedEtag: post1.etag,
          }),
          409,
        ).body.code,
      ).toBe('VERSION_CONFLICT');
      expectStatus(
        await post(w, 'POST_TREATMENT/close', { expectedEtag: s.etag }),
        200,
      );

      const both = expectStatus(await get(w), 200).body;
      expect(both.phases.DIAGNOSIS).toMatchObject({ state: 'CLOSED' });
      expect(both.phases.POST_TREATMENT).toMatchObject({ state: 'CLOSED' });
      expect(both.phases.POST_TREATMENT.data.teeth).toEqual(RESTORED_16);
      expect(both.phases.POST_TREATMENT.closure.integrityHash).toMatch(
        /^[0-9a-f]{64}$/,
      );
    });

    it('un borrador descartado permite empezar de nuevo; el contenido inválido se rechaza', async () => {
      const w = await world();
      const d = expectStatus(await post(w, 'DIAGNOSIS/draft'), 201).body
        .odontogram;
      expectStatus(
        await put(w, 'DIAGNOSIS', {
          data: doc({ '99': { status: 'ABSENT' } }),
          expectedEtag: d.etag,
        }),
        400,
      );
      expectStatus(
        await post(w, 'DIAGNOSIS/discard', {
          expectedEtag: d.etag,
          reason: 'Se abrió por error',
        }),
        200,
      );
      expect(
        expectStatus(await get(w), 200).body.actions.canStartDiagnosis,
      ).toBe(true);
      const again = expectStatus(await post(w, 'DIAGNOSIS/draft'), 201).body
        .odontogram;
      expect(again.version).toBe(3);
    });

    it('solo el odontólogo responsable de la visita escribe; los borradores ajenos no se ven', async () => {
      const w = await world();
      const d = expectStatus(await post(w, 'DIAGNOSIS/draft'), 201).body
        .odontogram;
      expectStatus(await post(w, 'DIAGNOSIS/draft', {}, w.other.token), 403);
      expectStatus(
        await put(
          w,
          'DIAGNOSIS',
          { data: doc(CARIES_16), expectedEtag: d.etag },
          w.other.token,
        ),
        403,
      );
      const seen = expectStatus(await get(w, w.other.token), 200).body;
      expect(seen.phases.DIAGNOSIS).toMatchObject({
        contentHidden: true,
        data: null,
      });
      expect(seen.actions.canStartDiagnosis).toBe(false);
    });
  });

  describe('cierre de la visita', () => {
    it('no cierra con una fase en borrador; al cerrar, el post tratamiento pasa a ser el odontograma vigente del paciente', async () => {
      const w = await world();
      await patientSaved(w, CARIES_16);
      await savePhase(w, 'DIAGNOSIS', CARIES_16);
      expectStatus(await post(w, 'POST_TREATMENT/draft'), 201);

      const sheet = (
        await ctx
          .http()
          .get(`${base(w)}/sheet`)
          .set(bearer(w.dentist.token))
          .expect(200)
      ).body;
      expect(sheet.actions.closeVisitBlockedBy).toContain('OPEN_ODONTOGRAM');
      expect(sheet.odontogram.phases).toMatchObject({
        DIAGNOSIS: { state: 'CLOSED' },
        POST_TREATMENT: { state: 'DRAFT' },
      });
      expect(JSON.stringify(sheet.odontogram)).not.toContain('teeth');

      const blocked = expectStatus(await closeVisit(w), 409);
      expect(blocked.body.code).toBe('OPEN_ODONTOGRAM');

      const head = expectStatus(await get(w), 200).body.phases.POST_TREATMENT;
      const s = expectStatus(
        await put(w, 'POST_TREATMENT', {
          data: doc(RESTORED_16),
          expectedEtag: head.etag,
        }),
        200,
      ).body.odontogram;
      expectStatus(
        await post(w, 'POST_TREATMENT/close', { expectedEtag: s.etag }),
        200,
      );

      const closed = expectStatus(await closeVisit(w), 200).body;
      expect(closed.status).toBe('CLOSED');
      expect(closed.odontogramPromoted).toEqual({ version: 4 });

      const chain = await patientChain(w.patientId);
      expect(
        chain.map((r) => `${r.version}:${r.status}:${r.changeKind}`),
      ).toEqual([
        '1:DRAFT:CREATED',
        '2:CLOSED:CREATED',
        '3:DRAFT:UPDATED',
        '4:CLOSED:UPDATED',
      ]);
      expect((chain[3]!.data as { teeth: unknown }).teeth).toEqual(RESTORED_16);
      expect(chain[3]!.createdById).toBe(w.dentist.user.id);

      const official = (
        await ctx
          .http()
          .get(`/v1/patients/${w.patientId}/clinical/odontogram`)
          .set(bearer(w.dentist.token))
          .expect(200)
      ).body.official;
      expect(official.version).toBe(4);

      const audit = await ctx.db.auditLog.findFirstOrThrow({
        where: { action: 'CLINICAL_ODONTOGRAM_CLOSED', patientId: w.patientId },
        orderBy: { createdAt: 'desc' },
      });
      expect(audit.summary).toMatchObject({
        source: 'visit',
        visitId: w.visit.id,
      });

      // Con la visita cerrada ya no se abre ni se guarda nada nuevo.
      expectStatus(await post(w, 'DIAGNOSIS/draft'), 409);
    });

    it('sin post tratamiento, el diagnóstico es el que pasa al paciente; si no cambia nada, no se agrega versión', async () => {
      const w = await world();
      await patientSaved(w, CARIES_16);
      // Diagnóstico idéntico al vigente: no hay nada que promover.
      const d = expectStatus(await post(w, 'DIAGNOSIS/draft'), 201).body
        .odontogram;
      expectStatus(
        await post(w, 'DIAGNOSIS/close', { expectedEtag: d.etag }),
        200,
      );
      const closed = expectStatus(await closeVisit(w), 200).body;
      expect(closed.odontogramPromoted).toBeNull();
      expect(await patientChain(w.patientId)).toHaveLength(2);
    });

    it('el primer odontograma del paciente puede nacer de la visita', async () => {
      const w = await world();
      await savePhase(w, 'DIAGNOSIS', { '36': { status: 'ABSENT' } });
      const closed = expectStatus(await closeVisit(w), 200).body;
      expect(closed.odontogramPromoted).toEqual({ version: 2 });
      const chain = await patientChain(w.patientId);
      expect(
        chain.map((r) => `${r.version}:${r.status}:${r.changeKind}`),
      ).toEqual(['1:DRAFT:CREATED', '2:CLOSED:CREATED']);
    });

    it('un borrador abierto en el odontograma general impide el cierre', async () => {
      const w = await world();
      await savePhase(w, 'DIAGNOSIS', CARIES_16);
      await ctx
        .http()
        .post(`/v1/patients/${w.patientId}/clinical/odontogram/draft`)
        .set(bearer(w.dentist.token))
        .send({})
        .expect(201);
      const blocked = expectStatus(await closeVisit(w), 409);
      expect(blocked.body.code).toBe('PATIENT_ODONTOGRAM_DRAFT');
      // Nada cambió: la visita sigue abierta y la cadena del paciente intacta.
      expect(
        (
          await ctx.db.clinicalVisit.findUniqueOrThrow({
            where: { id: w.visit.id },
          })
        ).status,
      ).toBe('OPEN');
      expect(await patientChain(w.patientId)).toHaveLength(1);
    });

    it('no se cancela una visita con odontograma registrado; descartado el borrador, sí', async () => {
      const w = await world();
      const d = expectStatus(await post(w, 'DIAGNOSIS/draft'), 201).body
        .odontogram;
      const cancel = () =>
        ctx
          .http()
          .post(`${base(w)}/cancel`)
          .set(bearer(w.dentist.token))
          .send({ expectedVersion: 1, reason: 'El paciente se retiró' });
      expect(expectStatus(await cancel(), 409).body.code).toBe(
        'HAS_ODONTOGRAM',
      );
      expectStatus(
        await post(w, 'DIAGNOSIS/discard', {
          expectedEtag: d.etag,
          reason: 'No se atendió',
        }),
        200,
      );
      expectStatus(await cancel(), 200);
    });
  });

  describe('corrección', () => {
    it('exige motivo y reautenticación; con la visita cerrada no cambia el odontograma del paciente', async () => {
      const w = await world();
      const saved = await savePhase(w, 'DIAGNOSIS', CARIES_16);
      expectStatus(await closeVisit(w), 200);
      const before = await patientChain(w.patientId);

      const body = {
        expectedEtag: saved.etag,
        data: doc(RESTORED_16),
        reason: 'Se registró la pieza equivocada',
      };
      expectStatus(await post(w, 'DIAGNOSIS/correct', body), 400); // sin contraseña
      const wrong = await post(w, 'DIAGNOSIS/correct', {
        ...body,
        password: 'incorrecta-123',
      });
      expect([401, 403]).toContain(wrong.status);
      const ok = expectStatus(
        await post(w, 'DIAGNOSIS/correct', { ...body, password: PASSWORD }),
        200,
      ).body;
      expect(ok.odontogram).toMatchObject({ state: 'CORRECTED', version: 3 });
      expect(ok.reauth).toMatchObject({ required: true, isSignature: false });
      expect(await patientChain(w.patientId)).toHaveLength(before.length);

      // Corregir sin cambiar nada no tiene sentido.
      expectStatus(
        await post(w, 'DIAGNOSIS/correct', {
          ...body,
          expectedEtag: ok.odontogram.etag,
          password: PASSWORD,
        }),
        409,
      );
    });
  });

  describe('exportación y auditoría', () => {
    it('el PDF trae ambas fases y las piezas que cambiaron; la auditoría no guarda contenido', async () => {
      const w = await world();
      await savePhase(w, 'DIAGNOSIS', CARIES_16, 'Nota-secreta-diagnostico');
      await savePhase(w, 'POST_TREATMENT', RESTORED_16);
      const res = await ctx
        .http()
        .get(`${base(w)}/odontogram/export`)
        .set(bearer(w.dentist.token))
        .buffer(true)
        .parse((r, cb) => {
          const c: Buffer[] = [];
          r.on('data', (d: Buffer) => c.push(d));
          r.on('end', () => cb(null, Buffer.concat(c)));
        });
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/pdf');
      const text = pdfText(res.body as Buffer);
      expect(text).toContain('Odontograma de diagn');
      expect(text).toContain('Odontograma post tratamiento');
      expect(text).toContain('Piezas que cambiaron');

      const logs = await ctx.db.auditLog.findMany({
        where: { patientId: w.patientId },
      });
      const dump = JSON.stringify(logs);
      expect(dump).toContain('CLINICAL_VISIT_ODONTOGRAM_CLOSED');
      expect(dump).toContain('CLINICAL_VISIT_ODONTOGRAM_EXPORTED');
      expect(dump).not.toContain('Nota-secreta-diagnostico');
      expect(dump).not.toContain('CARIES');
    });
  });

  describe('garantías en la base de datos', () => {
    it('una fase guardada no se edita ni se elimina, y el post tratamiento no nace sin diagnóstico guardado', async () => {
      const w = await world();
      const saved = await savePhase(w, 'DIAGNOSIS', CARIES_16);
      const row = await ctx.db.clinicalVisitOdontogram.findFirstOrThrow({
        where: { visitId: w.visit.id, version: saved.version },
      });
      await expect(
        ctx.db.clinicalVisitOdontogram.update({
          where: { id: row.id },
          data: { data: doc({}) },
        }),
      ).rejects.toThrow(/inmutable|no se edita/);
      await expect(
        ctx.db.clinicalVisitOdontogram.delete({ where: { id: row.id } }),
      ).rejects.toThrow(/no se eliminan/);

      const w2 = await world();
      await expect(
        ctx.db.clinicalVisitOdontogram.create({
          data: {
            clinicId: w2.clinic.id,
            patientId: w2.patientId,
            visitId: w2.visit.id,
            phase: 'POST_TREATMENT',
            version: 1,
            currentKey: `${w2.visit.id}|POST_TREATMENT`,
            status: 'DRAFT',
            dentition: 'PERMANENT',
            data: doc({}),
            changeKind: 'CREATED',
            createdById: w2.dentist.user.id,
          },
        }),
      ).rejects.toThrow(/parte de un diagnóstico guardado/);

      // La visita tampoco se cierra por la base de datos con un borrador pendiente.
      await post(w2, 'DIAGNOSIS/draft').expect(201);
      await expect(
        ctx.db.clinicalVisit.update({
          where: { id: w2.visit.id },
          data: {
            status: 'CLOSED',
            openKey: null,
            version: 2,
            closedAt: new Date(),
          },
        }),
      ).rejects.toThrow(/odontograma en borrador/);
    });
  });
});
