import type { LoggerService } from '@nestjs/common';
import { vi } from 'vitest';
import { AuditService } from '../src/audit/audit.service.js';
import { FIELD_CIPHER } from '../src/common/crypto/crypto.module.js';
import {
  actorIn,
  assignCare,
  assignCareReq,
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

describe('Antecedentes, alergias y alertas clínicas (3.2)', () => {
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
      branchA,
      branchB,
      admin,
      reception,
      cashier,
      dentist,
      assistant,
      director,
      patientId,
      rel,
    };
  }
  type W = Awaited<ReturnType<typeof world>>;

  const base = (id: string) => `/v1/patients/${id}/clinical`;
  const entryBody = (over: Record<string, unknown> = {}) => ({
    kind: 'ALLERGY',
    label: uniq('Penicilina-'),
    condition: 'Urticaria',
    category: 'Medicamento',
    severity: 'SEVERE',
    isCritical: true,
    onsetDate: '2015-03-02',
    source: 'PATIENT',
    observations: uniq('observ-'),
    reason: 'Registro inicial en la primera consulta',
    ...over,
  });
  const post = (token: string, id: string, path: string, body: unknown) =>
    ctx
      .http()
      .post(`${base(id)}${path}`)
      .set(bearer(token))
      .send(body as object);
  const get = (token: string, id: string, path: string) =>
    ctx
      .http()
      .get(`${base(id)}${path}`)
      .set(bearer(token));
  async function createEntry(
    w: W,
    over: Record<string, unknown> = {},
    token = w.dentist.token,
  ) {
    return expectStatus(
      await post(token, w.patientId, '/history', entryBody(over)),
      201,
    ).body as {
      id: string;
      version: number;
      label: string;
      observations: string;
    };
  }
  const changeBody = (version: number, over: Record<string, unknown> = {}) => ({
    expectedVersion: version,
    reason: 'Se corrige el dato registrado',
    ...over,
  });
  const alertBody = (over: Record<string, unknown> = {}) => ({
    severity: 'WARNING',
    text: uniq('Anticoagulado-'),
    source: 'PROFESSIONAL',
    reason: 'Informado por el paciente',
    ...over,
  });
  const versionsRows = (itemId: string) =>
    ctx.db.clinicalHistoryEntry.findMany({
      where: { itemId },
      orderBy: { version: 'asc' },
    });

  describe('registro y trazabilidad', () => {
    it('el odontólogo con relación registra una alergia crítica: versión 1, auditada sin contenido clínico', async () => {
      const w = await world();
      const body = entryBody();
      const res = expectStatus(
        await post(w.dentist.token, w.patientId, '/history', body),
        201,
      );
      expect(res.body).toMatchObject({
        version: 1,
        kind: 'ALLERGY',
        label: body.label,
        condition: 'Urticaria',
        severity: 'SEVERE',
        status: 'ACTIVE',
        isCritical: true,
        onsetDate: '2015-03-02',
        source: 'PATIENT',
        observations: body.observations,
        lastChange: {
          kind: 'CREATED',
          reason: body.reason,
          byUserId: w.dentist.user.id,
        },
      });
      const logs = await ctx.db.auditLog.findMany({
        where: { patientId: w.patientId, userId: w.dentist.user.id },
      });
      const created = logs.find((l) => l.action === 'CLINICAL_ENTRY_CREATED')!;
      expect(created).toMatchObject({
        entityId: res.body.id,
        clinicId: w.clinic.id,
      });
      expect(created.ip).toBeTruthy();
      expect(created.summary).toMatchObject({
        itemId: res.body.id,
        version: 1,
        entryKind: 'ALLERGY',
        changeKind: 'CREATED',
        via: 'care_relationship',
      });
      expect((created.summary as { fields: string[] }).fields).toEqual(
        expect.arrayContaining(['label', 'severity', 'observations']),
      );
      expect(logs.some((l) => l.action === 'CLINICAL_WRITE_AUTHORIZED')).toBe(
        true,
      );
      const dump = JSON.stringify(logs);
      for (const secret of [
        body.label,
        body.observations as string,
        body.condition,
        body.reason,
      ])
        expect(dump).not.toContain(secret);
    });

    it('lista, detalle y versiones (auditados como lectura clínica con la sección consultada)', async () => {
      const w = await world();
      const e = await createEntry(w);
      await createEntry(w, {
        kind: 'BACKGROUND',
        label: uniq('Hipertensión-'),
        isCritical: false,
      });
      const list = expectStatus(
        await get(w.dentist.token, w.patientId, '/history'),
        200,
      );
      expect(list.body).toHaveLength(2);
      expect(
        (
          await get(
            w.dentist.token,
            w.patientId,
            '/history?kind=ALLERGY',
          ).expect(200)
        ).body,
      ).toHaveLength(1);
      expect(
        (
          await get(w.dentist.token, w.patientId, `/history/${e.id}`).expect(
            200,
          )
        ).body,
      ).toMatchObject({ id: e.id, version: 1 });
      expect(
        (
          await get(
            w.dentist.token,
            w.patientId,
            `/history/${e.id}/versions`,
          ).expect(200)
        ).body,
      ).toHaveLength(1);
      const views = await ctx.db.auditLog.findMany({
        where: { patientId: w.patientId, action: 'CLINICAL_RECORD_VIEWED' },
      });
      const sections = views
        .map((v) => (v.summary as { sections: string[] }).sections[0])
        .sort((x, y) => String(x).localeCompare(String(y)));
      expect(sections).toEqual([
        'history',
        'history',
        'history',
        'history_versions',
      ]);
    });

    it('validación: motivo obligatorio también en el alta, fechas, enumerados y campos desconocidos; los errores no repiten lo enviado', async () => {
      const w = await world();
      const marker = uniq('SECRETO-');
      const cases: Record<string, unknown>[] = [
        { reason: undefined },
        { reason: 'ab' },
        { label: 'x' },
        { kind: 'DIAGNOSIS' },
        { severity: 'EXTREME' },
        { source: 'RUMOR' },
        { onsetDate: '2999-01-01' },
        { onsetDate: '2020-02-31' },
        { onsetDate: 'ayer' },
        { observations: 'a'.repeat(1001) },
        { isCritical: 'sí' },
        { diagnosis: marker },
        { label: marker, severity: 'EXTREME' },
      ];
      for (const over of cases) {
        const res = await post(
          w.dentist.token,
          w.patientId,
          '/history',
          entryBody(over),
        ).expect(400);
        expect(res.text).not.toContain(marker);
      }
      expect(
        await ctx.db.clinicalHistoryEntry.count({
          where: { patientId: w.patientId },
        }),
      ).toBe(0);
    });

    it('un paciente inactivo no admite registros nuevos', async () => {
      const w = await world();
      await ctx
        .http()
        .post(`/v1/patients/${w.patientId}/deactivate`)
        .set(bearer(w.reception.token))
        .send({ reason: 'Baja administrativa' })
        .expect(200);
      await post(w.dentist.token, w.patientId, '/history', entryBody()).expect(
        409,
      );
    });
  });

  describe('correcciones, rectificaciones y desactivaciones: el historial no se borra', () => {
    it('cada cambio crea una versión con motivo; las anteriores quedan intactas y solo una es la vigente', async () => {
      const w = await world();
      const e = await createEntry(w, { isCritical: false });
      const original = e.label;
      const corrected = expectStatus(
        await post(
          w.dentist.token,
          w.patientId,
          `/history/${e.id}/correct`,
          changeBody(1, {
            label: 'Amoxicilina',
            reason: 'Error de digitación en el nombre',
          }),
        ),
        200,
      );
      expect(corrected.body).toMatchObject({
        version: 2,
        label: 'Amoxicilina',
        lastChange: {
          kind: 'CORRECTED',
          reason: 'Error de digitación en el nombre',
        },
      });
      await post(
        w.dentist.token,
        w.patientId,
        `/history/${e.id}/rectify`,
        changeBody(2, {
          severity: 'MILD',
          condition: null,
          reason: 'El paciente aclaró la reacción',
        }),
      ).expect(200);
      await post(
        w.dentist.token,
        w.patientId,
        `/history/${e.id}/deactivate`,
        changeBody(3, { reason: 'Ya no aplica según el paciente' }),
      ).expect(200);
      await post(
        w.dentist.token,
        w.patientId,
        `/history/${e.id}/reactivate`,
        changeBody(4, { reason: 'Se confirmó que sí aplica' }),
      ).expect(200);
      await post(
        w.dentist.token,
        w.patientId,
        `/history/${e.id}/mark-error`,
        changeBody(5, { reason: 'Se registró en el paciente equivocado' }),
      ).expect(200);

      const rows = await versionsRows(e.id);
      expect(rows.map((r) => [r.version, r.changeKind, r.status])).toEqual([
        [1, 'CREATED', 'ACTIVE'],
        [2, 'CORRECTED', 'ACTIVE'],
        [3, 'RECTIFIED', 'ACTIVE'],
        [4, 'DEACTIVATED', 'INACTIVE'],
        [5, 'REACTIVATED', 'ACTIVE'],
        [6, 'MARKED_IN_ERROR', 'ENTERED_IN_ERROR'],
      ]);
      expect(rows[0]!.label).toBe(original); // la versión original sigue intacta
      expect(rows.filter((r) => r.currentKey !== null)).toHaveLength(1);
      expect(rows.at(-1)!.currentKey).toBe(e.id);
      expect(rows[2]).toMatchObject({ condition: null, severity: 'MILD' });
      expect(rows.map((r) => r.supersedesId)).toEqual([
        null,
        ...rows.slice(0, -1).map((r) => r.id),
      ]);

      const versions = (
        await get(
          w.dentist.token,
          w.patientId,
          `/history/${e.id}/versions`,
        ).expect(200)
      ).body as {
        version: number;
        changedFields: string[];
        lastChange: { reason: string };
      }[];
      expect(versions.map((v) => v.version)).toEqual([6, 5, 4, 3, 2, 1]);
      expect(versions.find((v) => v.version === 2)!.changedFields).toEqual([
        'label',
      ]);
      expect(
        versions.find((v) => v.version === 3)!.changedFields.sort(),
      ).toEqual(['condition', 'severity']);
      expect(versions.find((v) => v.version === 4)!.changedFields).toEqual([
        'status',
      ]);
      expect(versions.every((v) => v.lastChange.reason.length >= 3)).toBe(true);

      // por defecto no aparece en la lista (ingresado por error) pero se puede consultar y no se borró
      expect(
        (await get(w.dentist.token, w.patientId, '/history').expect(200)).body,
      ).toEqual([]);
      expect(
        (
          await get(
            w.dentist.token,
            w.patientId,
            '/history?status=ENTERED_IN_ERROR',
          ).expect(200)
        ).body,
      ).toHaveLength(1);
      // auditoría por acción, con versión y nombres de campos, sin valores
      const actions = (
        await ctx.db.auditLog.findMany({
          where: { entityId: e.id },
          orderBy: { createdAt: 'asc' },
        })
      ).map((l) => l.action);
      expect(actions).toEqual([
        'CLINICAL_ENTRY_CREATED',
        'CLINICAL_ENTRY_CORRECTED',
        'CLINICAL_ENTRY_RECTIFIED',
        'CLINICAL_ENTRY_DEACTIVATED',
        'CLINICAL_ENTRY_REACTIVATED',
        'CLINICAL_ENTRY_MARKED_IN_ERROR',
      ]);
    });

    it('estados inválidos, versión obsoleta y correcciones vacías se rechazan sin tocar el historial', async () => {
      const w = await world();
      const e = await createEntry(w);
      await post(
        w.dentist.token,
        w.patientId,
        `/history/${e.id}/reactivate`,
        changeBody(1),
      ).expect(409); // no estaba inactivo
      await post(
        w.dentist.token,
        w.patientId,
        `/history/${e.id}/correct`,
        changeBody(1),
      ).expect(400); // no cambia nada
      await post(
        w.dentist.token,
        w.patientId,
        `/history/${e.id}/correct`,
        changeBody(1, { label: e.label }),
      ).expect(400); // mismo valor
      const stale = await post(
        w.dentist.token,
        w.patientId,
        `/history/${e.id}/correct`,
        changeBody(7, { label: 'Otra cosa' }),
      ).expect(409);
      expect(stale.body).toMatchObject({
        code: 'VERSION_CONFLICT',
        currentVersion: 1,
      });
      expect(JSON.stringify(stale.body)).not.toContain(e.label);
      await post(
        w.dentist.token,
        w.patientId,
        `/history/${e.id}/deactivate`,
        changeBody(1),
      ).expect(200);
      await post(
        w.dentist.token,
        w.patientId,
        `/history/${e.id}/deactivate`,
        changeBody(2),
      ).expect(409);
      await post(
        w.dentist.token,
        w.patientId,
        `/history/${e.id}/mark-error`,
        changeBody(2),
      ).expect(200);
      await post(
        w.dentist.token,
        w.patientId,
        `/history/${e.id}/correct`,
        changeBody(3, { label: 'Tarde' }),
      ).expect(409);
      await post(
        w.dentist.token,
        w.patientId,
        `/history/${e.id}/mark-error`,
        changeBody(3),
      ).expect(409);
      await post(w.dentist.token, w.patientId, `/history/${e.id}/correct`, {
        expectedVersion: 3,
      }).expect(400); // sin motivo
      expect(await versionsRows(e.id)).toHaveLength(3);
    });

    it('la base de datos impide borrar, reescribir o encadenar mal las versiones', async () => {
      const w = await world();
      const e = await createEntry(w);
      await post(
        w.dentist.token,
        w.patientId,
        `/history/${e.id}/correct`,
        changeBody(1, { label: 'Otra' }),
      ).expect(200);
      const [v1, v2] = await versionsRows(e.id);
      const sql = (text: string, ...v: unknown[]) =>
        ctx.db.$executeRawUnsafe(text, ...v);
      await expect(
        sql('DELETE FROM clinical_history_entries WHERE id = ?', v1!.id),
      ).rejects.toThrow(/no se eliminan/);
      await expect(
        sql(
          "UPDATE clinical_history_entries SET label = 'Reescrita' WHERE id = ?",
          v1!.id,
        ),
      ).rejects.toThrow(/inmutable/);
      await expect(
        sql(
          "UPDATE clinical_history_entries SET label = 'Reescrita' WHERE id = ?",
          v2!.id,
        ),
      ).rejects.toThrow(/inmutable/);
      await expect(
        sql(
          'UPDATE clinical_history_entries SET current_key = item_id WHERE id = ?',
          v1!.id,
        ),
      ).rejects.toThrow(/inmutable/); // no se reabre
      const row = {
        clinicId: w.clinic.id,
        patientId: w.patientId,
        kind: 'ALLERGY' as const,
        label: 'X',
        source: 'PATIENT' as const,
        createdById: w.dentist.user.id,
      };
      const id = crypto.randomUUID();
      // versión 1 sin motivo / que no es CREATED / con supersedes
      await expect(
        ctx.db.clinicalHistoryEntry.create({
          data: {
            ...row,
            itemId: id,
            version: 1,
            currentKey: id,
            changeKind: 'CREATED',
            changeReason: 'ab',
          },
        }),
      ).rejects.toThrow(/motivo/);
      await expect(
        ctx.db.clinicalHistoryEntry.create({
          data: {
            ...row,
            itemId: id,
            version: 1,
            currentKey: id,
            changeKind: 'CORRECTED',
            changeReason: 'Motivo válido',
          },
        }),
      ).rejects.toThrow(/versión 1/);
      // versión que salta, de otro paciente o con supersedes ajeno
      await expect(
        ctx.db.clinicalHistoryEntry.create({
          data: {
            ...row,
            itemId: e.id,
            version: 9,
            supersedesId: v2!.id,
            currentKey: e.id,
            changeKind: 'CORRECTED',
            changeReason: 'Motivo válido',
          },
        }),
      ).rejects.toThrow();
      const other = (await createPatient(ctx, w.reception.token)).id;
      await expect(
        ctx.db.clinicalHistoryEntry.create({
          data: {
            ...row,
            patientId: other,
            itemId: e.id,
            version: 3,
            supersedesId: v2!.id,
            currentKey: e.id,
            changeKind: 'CORRECTED',
            changeReason: 'Motivo válido',
          },
        }),
      ).rejects.toThrow(/continuar/);
      // un paciente de otra clínica no se puede enlazar (FK compuesta)
      const otherClinic = await fx.clinic();
      await expect(
        ctx.db.clinicalHistoryEntry.create({
          data: {
            ...row,
            clinicId: otherClinic.id,
            itemId: crypto.randomUUID(),
            version: 1,
            currentKey: null as never,
            changeKind: 'CREATED',
            changeReason: 'Motivo válido',
          },
        }),
      ).rejects.toThrow();
      expect(await versionsRows(e.id)).toHaveLength(2);
    });
  });

  describe('alertas', () => {
    it('una alergia o antecedente crítico activo genera una alerta derivada; desactivarla o quitar lo crítico la retira', async () => {
      const w = await world();
      const allergy = await createEntry(w, { label: uniq('Látex-') });
      const calm = await createEntry(w, {
        kind: 'BACKGROUND',
        label: uniq('Asma-'),
        isCritical: false,
      });
      const crit = await createEntry(w, {
        kind: 'BACKGROUND',
        label: uniq('Marcapasos-'),
        isCritical: true,
        severity: 'NOT_SPECIFIED',
      });
      let alerts = (
        await get(w.dentist.token, w.patientId, '/alerts').expect(200)
      ).body;
      expect(alerts.advisory).toBe(true);
      expect(alerts.access).toMatchObject({ level: 'FULL' });
      expect(alerts.alerts.map((a: { id: string }) => a.id).sort()).toEqual(
        [allergy.id, crit.id].sort(),
      );
      expect(
        alerts.alerts.every(
          (a: { severity: string }) => a.severity === 'CRITICAL',
        ),
      ).toBe(true);
      expect(
        alerts.alerts.find((a: { id: string }) => a.id === allergy.id),
      ).toMatchObject({
        origin: 'ALLERGY',
        label: allergy.label,
        source: 'PATIENT',
      });
      expect(alerts.alerts.some((a: { id: string }) => a.id === calm.id)).toBe(
        false,
      );

      await post(
        w.dentist.token,
        w.patientId,
        `/history/${allergy.id}/deactivate`,
        changeBody(1),
      ).expect(200);
      await post(
        w.dentist.token,
        w.patientId,
        `/history/${crit.id}/rectify`,
        changeBody(1, { isCritical: false }),
      ).expect(200);
      await post(
        w.dentist.token,
        w.patientId,
        `/history/${calm.id}/rectify`,
        changeBody(1, { isCritical: true }),
      ).expect(200);
      alerts = (await get(w.dentist.token, w.patientId, '/alerts').expect(200))
        .body;
      expect(alerts.alerts.map((a: { id: string }) => a.id)).toEqual([calm.id]);
      // con includeInactive el nivel completo ve la desactivada
      const all = (
        await get(
          w.dentist.token,
          w.patientId,
          '/alerts?includeInactive=true',
        ).expect(200)
      ).body;
      expect(all.alerts.map((a: { id: string }) => a.id)).toContain(allergy.id);
    });

    it('alertas manuales: severidad, vigencia, origen y motivo; corregir, desactivar y reactivar conservan las versiones', async () => {
      const w = await world();
      const future = new Date(Date.now() + 3 * 86_400_000).toISOString();
      const created = expectStatus(
        await post(
          w.dentist.token,
          w.patientId,
          '/alerts',
          alertBody({ severity: 'CRITICAL', expiresAt: future }),
        ),
        201,
      ).body;
      expect(created).toMatchObject({
        version: 1,
        origin: 'MANUAL',
        severity: 'CRITICAL',
        status: 'ACTIVE',
        source: 'PROFESSIONAL',
        lastChange: { kind: 'CREATED', reason: 'Informado por el paciente' },
      });
      expect(new Date(created.validUntil).toISOString()).toBe(future);
      await post(
        w.dentist.token,
        w.patientId,
        '/alerts',
        alertBody({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
      ).expect(400);
      await post(
        w.dentist.token,
        w.patientId,
        '/alerts',
        alertBody({ severity: 'GRAVE' }),
      ).expect(400);
      await post(
        w.dentist.token,
        w.patientId,
        '/alerts',
        alertBody({ reason: '' }),
      ).expect(400);

      await post(
        w.dentist.token,
        w.patientId,
        `/alerts/${created.id}/correct`,
        changeBody(1, { severity: 'WARNING', reason: 'Se baja la severidad' }),
      ).expect(200);
      await post(
        w.dentist.token,
        w.patientId,
        `/alerts/${created.id}/deactivate`,
        changeBody(2),
      ).expect(200);
      expect(
        (await get(w.dentist.token, w.patientId, '/alerts').expect(200)).body
          .alerts,
      ).toEqual([]);
      await post(
        w.dentist.token,
        w.patientId,
        `/alerts/${created.id}/reactivate`,
        changeBody(3),
      ).expect(200);
      expect(
        (await get(w.dentist.token, w.patientId, '/alerts').expect(200)).body
          .alerts,
      ).toHaveLength(1);
      await post(
        w.dentist.token,
        w.patientId,
        `/alerts/${created.id}/correct`,
        changeBody(9, { text: 'tarde' }),
      ).expect(409);
      await post(
        w.dentist.token,
        w.patientId,
        `/alerts/${created.id}/mark-error`,
        changeBody(4),
      ).expect(200);
      const rows = await ctx.db.clinicalAlert.findMany({
        where: { itemId: created.id },
        orderBy: { version: 'asc' },
      });
      expect(rows.map((r) => r.changeKind)).toEqual([
        'CREATED',
        'CORRECTED',
        'DEACTIVATED',
        'REACTIVATED',
        'MARKED_IN_ERROR',
      ]);
      expect(rows.filter((r) => r.currentKey)).toHaveLength(1);
      const versions = (
        await get(
          w.dentist.token,
          w.patientId,
          `/alerts/${created.id}/versions`,
        ).expect(200)
      ).body;
      expect(versions).toHaveLength(5);
      await expect(
        ctx.db.clinicalAlert.delete({ where: { id: rows[0]!.id } }),
      ).rejects.toThrow(/no se eliminan/);
      await expect(
        ctx.db.clinicalAlert.update({
          where: { id: rows[0]!.id },
          data: { text: 'reescrita' },
        }),
      ).rejects.toThrow(/inmutable/);
    });

    it('una alerta vencida deja de mostrarse (queda en el historial)', async () => {
      const w = await world();
      const itemId = crypto.randomUUID();
      const past = new Date(Date.now() - 1000);
      await ctx.db.clinicalAlert.create({
        data: {
          clinicId: w.clinic.id,
          patientId: w.patientId,
          itemId,
          version: 1,
          currentKey: itemId,
          severity: 'CRITICAL',
          text: 'Vencida',
          source: 'OTHER',
          expiresAt: past,
          changeKind: 'CREATED',
          changeReason: 'Prueba de vigencia',
          createdById: w.dentist.user.id,
        },
      });
      expect(
        (await get(w.dentist.token, w.patientId, '/alerts').expect(200)).body
          .alerts,
      ).toEqual([]);
      expect(
        (
          await get(
            w.dentist.token,
            w.patientId,
            '/alerts?includeInactive=true',
          ).expect(200)
        ).body.alerts.map((a: { label: string }) => a.label),
      ).toContain('Vencida');
      expect(
        (await get(w.assistant.token, w.patientId, '/alerts').expect(200)).body
          .alerts,
      ).toEqual([]);
    });

    it('las alertas son informativas: no hay endpoint que decida o bloquee y la respuesta lo declara', async () => {
      const w = await world();
      await createEntry(w);
      const res = (
        await get(w.dentist.token, w.patientId, '/alerts').expect(200)
      ).body;
      expect(res.advisory).toBe(true);
      // agendar/registrar administrativamente sigue funcionando con alertas críticas activas
      await ctx
        .http()
        .patch(`/v1/patients/${w.patientId}`)
        .set(bearer(w.reception.token))
        .send({ firstName: 'Nombre Nuevo' })
        .expect(200);
    });
  });

  describe('vista limitada del asistente', () => {
    it('solo ve alertas activas y mínimas; nunca el historial, las versiones ni notas', async () => {
      const w = await world();
      const dentist2 = await fx.userWithRole('DENTIST', {
        clinicId: w.clinic.id,
      });
      await assignCare(ctx, w.reception.token, w.patientId, dentist2.user.id);
      const crit = await createEntry(w, {
        label: uniq('Anestésico-'),
        observations: uniq('NOTA-LARGA-'),
        condition: uniq('Reaccion-'),
      });
      await createEntry(w, {
        label: uniq('NoCritica-'),
        isCritical: false,
        observations: uniq('NOTA-NO-CRITICA-'),
      });
      const manual = (
        await post(
          w.dentist.token,
          w.patientId,
          '/alerts',
          alertBody({ severity: 'INFO' }),
        ).expect(201)
      ).body;
      const gone = (
        await post(
          w.dentist.token,
          w.patientId,
          '/alerts',
          alertBody({ severity: 'CRITICAL', text: uniq('Desactivada-') }),
        ).expect(201)
      ).body;
      await post(
        w.dentist.token,
        w.patientId,
        `/alerts/${gone.id}/deactivate`,
        changeBody(1),
      ).expect(200);

      const res = (
        await get(w.assistant.token, w.patientId, '/alerts').expect(200)
      ).body;
      expect(res.access).toMatchObject({ level: 'LIMITED' });
      expect(res.alerts.map((a: { id: string }) => a.id)).toEqual([
        crit.id,
        manual.id,
      ]); // críticas primero
      for (const a of res.alerts)
        expect(Object.keys(a).sort()).toEqual([
          'id',
          'label',
          'origin',
          'severity',
          'validUntil',
        ]);
      const text = JSON.stringify(res);
      for (const hidden of [
        crit.observations,
        'Reaccion-',
        'NOTA-',
        'NoCritica-',
        'Desactivada-',
        'Informado por el paciente',
        'Urticaria',
      ])
        expect(text).not.toContain(hidden);

      // resumen: misma vista mínima
      const summary = (
        await ctx
          .http()
          .get(`/v1/patients/${w.patientId}/clinical-summary`)
          .set(bearer(w.assistant.token))
          .expect(200)
      ).body;
      expect(summary.clinicalAlerts.map((a: { id: string }) => a.id)).toEqual([
        crit.id,
        manual.id,
      ]);
      expect(summary).not.toHaveProperty('sections');

      // todo lo demás, denegado y auditado como vista limitada
      for (const path of [
        '/history',
        `/history/${crit.id}`,
        `/history/${crit.id}/versions`,
        `/alerts/${manual.id}/versions`,
      ]) {
        const denied = await get(w.assistant.token, w.patientId, path).expect(
          403,
        );
        expect(denied.body.code).toBe('CLINICAL_LIMITED_VIEW');
      }
      await post(
        w.assistant.token,
        w.patientId,
        '/history',
        entryBody(),
      ).expect(403);
      await post(w.assistant.token, w.patientId, '/alerts', alertBody()).expect(
        403,
      );
      await post(
        w.assistant.token,
        w.patientId,
        `/alerts/${manual.id}/deactivate`,
        changeBody(1),
      ).expect(403);
      const denials = await ctx.db.auditLog.findMany({
        where: {
          userId: w.assistant.user.id,
          action: 'CLINICAL_ACCESS_DENIED',
        },
      });
      expect(
        denials.filter(
          (d) =>
            (d.summary as { reason: string }).reason === 'limited_view_only',
        ),
      ).toHaveLength(4);
    });

    it('sin relación vigente en su sede no ve ni las alertas', async () => {
      const w = await world();
      await createEntry(w);
      const outside = await actorIn(ctx, fx, 'ASSISTANT', {
        clinicId: w.clinic.id,
        branchId: w.branchA.id,
      });
      // la relación del mundo es de toda la clínica; una de sede B no cubre a un asistente de la sede A
      const p2 = (await createPatient(ctx, w.reception.token)).id;
      const d2 = await fx.userWithRole('DENTIST', {
        clinicId: w.clinic.id,
        branchId: w.branchB.id,
      });
      await assignCare(ctx, w.reception.token, p2, d2.user.id, {
        branchId: w.branchB.id,
      });
      expect(
        (await get(outside.token, p2, '/alerts').expect(403)).body.code,
      ).toBe('NO_CARE_RELATIONSHIP');
      expect(
        (await get(outside.token, w.patientId, '/alerts').expect(200)).body
          .access.level,
      ).toBe('LIMITED');
    });
  });

  describe('quién ve y quién no (permiso clínico + relación)', () => {
    it('plataforma, administración, recepción y caja no ven ni escriben nada clínico: 403 genérico idéntico exista o no el paciente', async () => {
      const w = await world();
      const e = await createEntry(w);
      const { user } = await fx.userWithRole('PLATFORM_ADMIN');
      const platform = await loginInContext(ctx, user.email);
      for (const token of [
        platform,
        w.admin.token,
        w.reception.token,
        w.cashier.token,
      ]) {
        for (const path of [
          '/history',
          `/history/${e.id}`,
          `/history/${e.id}/versions`,
          '/alerts',
        ]) {
          const real = await get(token, w.patientId, path).expect(403);
          const ghost = await get(token, GHOST, path).expect(403);
          expect(real.body.message).toBe(ghost.body.message);
        }
        await post(token, w.patientId, '/history', entryBody()).expect(403);
        await post(token, w.patientId, '/alerts', alertBody()).expect(403);
        await post(
          token,
          w.patientId,
          `/history/${e.id}/deactivate`,
          changeBody(1),
        ).expect(403);
        await ctx
          .http()
          .get('/v1/clinical/options')
          .set(bearer(token))
          .expect(403);
      }
      expect(await versionsRows(e.id)).toHaveLength(1);
    });

    it('odontólogo sin relación, con relación revocada o de otro odontólogo: ni lee ni escribe', async () => {
      const w = await world();
      const e = await createEntry(w);
      const stranger = await actorIn(ctx, fx, 'DENTIST', {
        clinicId: w.clinic.id,
      });
      for (const path of ['/history', `/history/${e.id}`, '/alerts'])
        expect(
          (await get(stranger.token, w.patientId, path).expect(403)).body.code,
        ).toBe('NO_CARE_RELATIONSHIP');
      await post(stranger.token, w.patientId, '/history', entryBody()).expect(
        403,
      );
      await post(
        stranger.token,
        w.patientId,
        `/history/${e.id}/deactivate`,
        changeBody(1),
      ).expect(403);

      await revokeCareReq(ctx, w.reception.token, w.rel.id).expect(200); // el titular pierde la relación
      for (const path of [
        '/history',
        `/history/${e.id}`,
        `/history/${e.id}/versions`,
        '/alerts',
      ])
        expect(
          (await get(w.dentist.token, w.patientId, path).expect(403)).body.code,
        ).toBe('NO_CARE_RELATIONSHIP');
      await post(
        w.dentist.token,
        w.patientId,
        `/history/${e.id}/correct`,
        changeBody(1, { label: 'Tarde' }),
      ).expect(403);
      expect(await versionsRows(e.id)).toHaveLength(1);
      const denied = await ctx.db.auditLog.findMany({
        where: { userId: w.dentist.user.id, action: 'CLINICAL_ACCESS_DENIED' },
      });
      expect(denied.length).toBeGreaterThanOrEqual(5);
      expect(denied.every((d) => d.patientId === w.patientId)).toBe(true);
    });

    it('relación de otra sede: se lee desde cualquier sede, pero se escribe solo en la sede de origen', async () => {
      const w = await world();
      const d = await fx.user();
      await fx.assign(d.id, 'DENTIST', {
        clinicId: w.clinic.id,
        branchId: w.branchA.id,
      });
      await fx.assign(d.id, 'DENTIST', {
        clinicId: w.clinic.id,
        branchId: w.branchB.id,
      });
      const p = (await createPatient(ctx, w.reception.token)).id;
      await assignCare(ctx, w.reception.token, p, d.id, {
        branchId: w.branchB.id,
      }); // se atendió en B
      const inA = await loginInContext(ctx, d.email, {
        clinicId: w.clinic.id,
        branchId: w.branchA.id,
      });
      const inB = await loginInContext(ctx, d.email, {
        clinicId: w.clinic.id,
        branchId: w.branchB.id,
      });
      const e = expectStatus(
        await post(inB, p, '/history', entryBody()),
        201,
      ).body;
      await get(inA, p, '/history').expect(200); // continuidad asistencial
      await get(inA, p, `/history/${e.id}`).expect(200);
      const wrong = await post(inA, p, '/history', entryBody()).expect(403);
      expect(wrong.body.code).toBe('WRONG_BRANCH');
      await post(inA, p, `/history/${e.id}/deactivate`, changeBody(1)).expect(
        403,
      );
      await post(inB, p, `/history/${e.id}/deactivate`, changeBody(1)).expect(
        200,
      );
    });
  });

  describe('Director Clínico', () => {
    it('sin autorización excepcional no lee nada; con ella lee (solo lectura) únicamente a ese paciente', async () => {
      const w = await world();
      const e = await createEntry(w);
      await post(w.dentist.token, w.patientId, '/alerts', alertBody()).expect(
        201,
      );
      const other = (await createPatient(ctx, w.reception.token)).id;
      for (const path of [
        '/history',
        `/history/${e.id}`,
        `/history/${e.id}/versions`,
        '/alerts',
      ]) {
        expect(
          (await get(w.director.token, w.patientId, path).expect(403)).body
            .code,
        ).toBe('CLINICAL_JUSTIFICATION_REQUIRED');
      }
      expectStatus(await grantReadAll(ctx, w.director.token, w.patientId), 201);
      expect(
        (await get(w.director.token, w.patientId, '/history').expect(200)).body,
      ).toHaveLength(1);
      expect(
        (
          await get(
            w.director.token,
            w.patientId,
            `/history/${e.id}/versions`,
          ).expect(200)
        ).body,
      ).toHaveLength(1);
      const alerts = (
        await get(w.director.token, w.patientId, '/alerts').expect(200)
      ).body;
      expect(alerts.access).toMatchObject({ level: 'READ_ALL' });
      expect(alerts.alerts).toHaveLength(2);
      // otro paciente: sin autorización
      expect(
        (await get(w.director.token, other, '/history').expect(403)).body.code,
      ).toBe('CLINICAL_JUSTIFICATION_REQUIRED');
      // nunca escribe, ni con autorización
      await post(w.director.token, w.patientId, '/history', entryBody()).expect(
        403,
      );
      await post(w.director.token, w.patientId, '/alerts', alertBody()).expect(
        403,
      );
      await post(
        w.director.token,
        w.patientId,
        `/history/${e.id}/deactivate`,
        changeBody(1),
      ).expect(403);
      const reads = await ctx.db.auditLog.findMany({
        where: { patientId: w.patientId, action: 'CLINICAL_READ_ALL_READ' },
      });
      expect(reads).toHaveLength(3); // cada lectura, auditada con su autorización de origen
      expect(
        reads.every((r) => (r.summary as { grantId?: string }).grantId),
      ).toBe(true);
      expect(await versionsRows(e.id)).toHaveLength(1);
    });

    it('una autorización vencida no sirve para el historial', async () => {
      const w = await world();
      await createEntry(w);
      const past = new Date(Date.now() - 3 * 3_600_000);
      await ctx.db.clinicalAccessGrant.create({
        data: {
          clinicId: w.clinic.id,
          patientId: w.patientId,
          userId: w.director.user.id,
          sessionId: JSON.parse(
            Buffer.from(
              w.director.token.split('.')[1]!,
              'base64url',
            ).toString(),
          ).sid,
          category: 'OTHER',
          reason: 'Autorización de prueba vencida',
          grantedAt: past,
          expiresAt: new Date(past.getTime() + 30 * 60_000),
        },
      });
      expect(
        (await get(w.director.token, w.patientId, '/history').expect(403)).body
          .code,
      ).toBe('CLINICAL_JUSTIFICATION_REQUIRED');
    });
  });

  describe('aislamiento entre clínicas y no enumeración', () => {
    it('otra clínica recibe 404 idéntico al de un id inexistente, también con ids de elementos ajenos; nada se asocia al paciente ajeno', async () => {
      const w = await world();
      const e = await createEntry(w);
      const alert = (
        await post(w.dentist.token, w.patientId, '/alerts', alertBody()).expect(
          201,
        )
      ).body;
      const other = await fx.clinic();
      const dentistB = await actorIn(ctx, fx, 'DENTIST', {
        clinicId: other.id,
      });
      const directorB = await actorIn(ctx, fx, 'CLINICAL_DIRECTOR', {
        clinicId: other.id,
      });
      const receptionB = await actorIn(ctx, fx, 'RECEPTIONIST', {
        clinicId: other.id,
      });
      const { id: patientB } = await createPatient(ctx, receptionB.token);
      await assignCare(ctx, receptionB.token, patientB, dentistB.user.id);

      for (const token of [dentistB.token, directorB.token]) {
        for (const path of [
          '/history',
          `/history/${e.id}`,
          `/history/${e.id}/versions`,
          '/alerts',
          `/alerts/${alert.id}/versions`,
        ]) {
          const foreign = await get(token, w.patientId, path).expect(404);
          const ghost = await get(token, GHOST, path).expect(404);
          expect(foreign.body.message).toBe(ghost.body.message);
        }
      }
      await post(dentistB.token, w.patientId, '/history', entryBody()).expect(
        404,
      );
      await post(dentistB.token, w.patientId, '/alerts', alertBody()).expect(
        404,
      );
      // elementos de A con un paciente PROPIO de B: no existen para B (404), y no se modifican
      await get(dentistB.token, patientB, `/history/${e.id}`).expect(404);
      await post(
        dentistB.token,
        patientB,
        `/history/${e.id}/deactivate`,
        changeBody(1),
      ).expect(404);
      await post(
        dentistB.token,
        patientB,
        `/alerts/${alert.id}/deactivate`,
        changeBody(1),
      ).expect(404);
      expect(await versionsRows(e.id)).toHaveLength(1);
      const rows = await ctx.db.auditLog.findMany({
        where: {
          userId: { in: [dentistB.user.id, directorB.user.id] },
          action: 'CLINICAL_ACCESS_DENIED',
        },
      });
      expect(rows.length).toBeGreaterThanOrEqual(10);
      for (const r of rows.filter(
        (x) =>
          (x.summary as { reason: string }).reason === 'patient_unavailable',
      )) {
        expect(r.patientId).toBeNull();
        expect(JSON.stringify(r)).not.toContain(w.patientId);
      }
      // enumeración: ids aleatorios, ajenos y de otra clínica se ven igual
      const messages = new Set<string>();
      for (const id of [
        GHOST,
        w.patientId,
        ...Array.from({ length: 8 }, () => crypto.randomUUID()),
      ])
        messages.add(
          (await get(dentistB.token, id, '/history').expect(404)).body.message,
        );
      expect(messages.size).toBe(1);
    });
  });

  describe('el contenido clínico no aparece fuera de las vías autorizadas', () => {
    it('ni en auditoría, listados, búsquedas, ficha, errores ni logs', async () => {
      const w = await world();
      const marker = uniq('CONTENIDO-CLINICO-');
      const e = await createEntry(w, {
        label: `${marker}-label`,
        condition: `${marker}-cond`,
        observations: `${marker}-obs`,
        reason: `${marker}-motivo`,
      });
      await post(
        w.dentist.token,
        w.patientId,
        '/alerts',
        alertBody({
          text: `${marker}-alerta`,
          reason: `${marker}-motivo-alerta`,
        }),
      ).expect(201);
      await post(
        w.dentist.token,
        w.patientId,
        `/history/${e.id}/correct`,
        changeBody(1, {
          observations: `${marker}-obs2`,
          reason: `${marker}-motivo2`,
        }),
      ).expect(200);
      await post(
        w.dentist.token,
        w.patientId,
        `/history/${e.id}/correct`,
        changeBody(1, { observations: `${marker}-conflicto` }),
      ).expect(409);
      await post(
        w.dentist.token,
        w.patientId,
        '/history',
        entryBody({ label: `${marker}-x`, severity: 'NADA' }),
      ).expect(400);
      expectStatus(
        await grantReadAll(ctx, w.director.token, w.patientId),
        201,
      );
      await get(w.director.token, w.patientId, '/history').expect(200);

      const contains = (value: unknown) =>
        JSON.stringify(value).includes(marker);
      // auditoría (toda la tabla)
      expect(contains(await ctx.db.auditLog.findMany({}))).toBe(false);
      // por la API de auditoría (administración)
      for (const q of [
        '',
        '?action=CLINICAL_ENTRY_CREATED',
        `?patientId=${w.patientId}&limit=100`,
      ]) {
        const res = await ctx
          .http()
          .get(`/v1/audit-logs${q}`)
          .set(bearer(w.admin.token))
          .expect(200);
        expect(res.text).not.toContain(marker);
      }
      // búsquedas, ficha, duplicados, relaciones, consentimientos
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
          .get(`/v1/patients/${w.patientId}`)
          .set(bearer(w.dentist.token)),
        await ctx
          .http()
          .get(`/v1/patients/${w.patientId}/duplicates`)
          .set(bearer(w.admin.token)),
        await ctx
          .http()
          .get(`/v1/patients/${w.patientId}/consents`)
          .set(bearer(w.dentist.token)),
        await ctx
          .http()
          .get(`/v1/patients/${w.patientId}/care-relationships`)
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
          .get(`/v1/patients/${w.patientId}/clinical-summary`)
          .set(bearer(w.dentist.token)),
      ];
      expect(responses.map((r) => r.status).every((s) => s === 200)).toBe(true);
      // el resumen del odontólogo SÍ lleva las alertas autorizadas (la alerta), pero nunca observaciones ni motivos
      const dentistSummary = responses.at(-1)!.text;
      // (la alerta y su motivo son contenido autorizado para el odontólogo; observaciones y motivos de versiones, no)
      expect(dentistSummary).not.toContain(`${marker}-obs`);
      expect(dentistSummary).not.toContain(`${marker}-motivo2`);
      for (const r of responses.slice(0, 8))
        expect(r.text).not.toContain(marker);
      // errores
      for (const res of [
        await get(w.reception.token, w.patientId, '/history'),
        await get(w.dentist.token, GHOST, '/history'),
        await get(w.dentist.token, w.patientId, `/history/${GHOST}`),
      ]) {
        expect(res.text).not.toContain(marker);
      }
      // logs
      expect(logger.lines.join('\n')).not.toContain(marker);
      expect(logger.lines.length).toBeGreaterThan(0);
    });

    it('el cifrado por campo está preparado pero NO activo: el cifrador está apagado y el texto se guarda en claro', async () => {
      const w = await world();
      expect(ctx.app.get(FIELD_CIPHER).enabled).toBe(false);
      const e = await createEntry(w);
      const [row] = await versionsRows(e.id);
      expect(row!.label).toBe(e.label); // el requisito efectivo es cifrado de volumen y respaldos
    });
  });

  describe('falla cerrada', () => {
    it('si falla la auditoría de la lectura: 503 y ningún dato clínico', async () => {
      const w = await world();
      const e = await createEntry(w);
      const audit = ctx.app.get(AuditService);
      const original = audit.record.bind(audit);
      vi.spyOn(audit, 'record').mockImplementation(async (entry, tx) => {
        if (entry.action === 'CLINICAL_RECORD_VIEWED')
          throw new Error('auditoría caída');
        return original(entry, tx);
      });
      for (const path of [
        '/history',
        `/history/${e.id}`,
        `/history/${e.id}/versions`,
        '/alerts',
      ]) {
        const res = await get(w.dentist.token, w.patientId, path).expect(503);
        expect(res.text).not.toContain(e.label);
        expect(res.text).not.toContain(e.observations);
      }
    });

    it('si falla la auditoría de la escritura, no queda ningún registro a medias', async () => {
      const w = await world();
      const e = await createEntry(w);
      const audit = ctx.app.get(AuditService);
      const original = audit.record.bind(audit);
      vi.spyOn(audit, 'record').mockImplementation(async (entry, tx) => {
        if (
          entry.action.startsWith('CLINICAL_ENTRY_') ||
          entry.action.startsWith('CLINICAL_ALERT_')
        )
          throw new Error('auditoría caída');
        return original(entry, tx);
      });
      expect(
        (await post(w.dentist.token, w.patientId, '/history', entryBody()))
          .status,
      ).toBeGreaterThanOrEqual(500);
      expect(
        (
          await post(
            w.dentist.token,
            w.patientId,
            `/history/${e.id}/correct`,
            changeBody(1, { label: 'Nueva' }),
          )
        ).status,
      ).toBeGreaterThanOrEqual(500);
      expect(
        (await post(w.dentist.token, w.patientId, '/alerts', alertBody()))
          .status,
      ).toBeGreaterThanOrEqual(500);
      vi.restoreAllMocks();
      expect(
        await ctx.db.clinicalHistoryEntry.count({
          where: { patientId: w.patientId },
        }),
      ).toBe(1);
      expect(
        await ctx.db.clinicalAlert.count({ where: { patientId: w.patientId } }),
      ).toBe(0);
      expect((await versionsRows(e.id))[0]!.currentKey).toBe(e.id); // la vigente sigue vigente
    });
  });

  describe('concurrencia', () => {
    const chainIsSound = async (itemId: string) => {
      const rows = await versionsRows(itemId);
      expect(rows.map((r) => r.version)).toEqual(rows.map((_, i) => i + 1));
      expect(rows.filter((r) => r.currentKey !== null)).toHaveLength(1);
      expect(rows.at(-1)!.currentKey).toBe(itemId);
      return rows;
    };

    it('correcciones simultáneas sobre la misma versión: exactamente una prospera y la cadena queda íntegra', async () => {
      const w = await world();
      const e = await createEntry(w);
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          post(
            w.dentist.token,
            w.patientId,
            `/history/${e.id}/correct`,
            changeBody(1, { label: `Variante ${i}` }),
          ),
        ),
      );
      const statuses = results.map((r) => r.status).sort((a, b) => a - b);
      expect(statuses).toEqual([200, 409, 409, 409, 409, 409]);
      const rows = await chainIsSound(e.id);
      expect(rows).toHaveLength(2);
      expect(
        await ctx.db.auditLog.count({
          where: { entityId: e.id, action: 'CLINICAL_ENTRY_CORRECTED' },
        }),
      ).toBe(1);
    });

    it('desactivar y corregir a la vez, o desactivar varias veces: una sola gana', async () => {
      for (let round = 0; round < 4; round++) {
        const w = await world();
        const e = await createEntry(w);
        const [a, b] = await Promise.all([
          post(
            w.dentist.token,
            w.patientId,
            `/history/${e.id}/deactivate`,
            changeBody(1),
          ),
          post(
            w.dentist.token,
            w.patientId,
            `/history/${e.id}/correct`,
            changeBody(1, { label: 'Corregida' }),
          ),
        ]);
        expect([a.status, b.status].sort((x, y) => x - y), `ronda ${round}`).toEqual([
          200, 409,
        ]);
        expect(await chainIsSound(e.id)).toHaveLength(2);
        const many = await Promise.all(
          Array.from({ length: 4 }, () =>
            post(
              w.dentist.token,
              w.patientId,
              `/history/${e.id}/mark-error`,
              changeBody(2),
            ),
          ),
        );
        expect(many.map((r) => r.status).sort((x, y) => x - y), `ronda ${round}`).toEqual([
          200, 409, 409, 409,
        ]);
        expect(await chainIsSound(e.id)).toHaveLength(3);
      }
    });

    it('alertas: cambios simultáneos sobre la misma versión también se serializan', async () => {
      const w = await world();
      const a = (
        await post(w.dentist.token, w.patientId, '/alerts', alertBody()).expect(
          201,
        )
      ).body;
      const results = await Promise.all([
        post(
          w.dentist.token,
          w.patientId,
          `/alerts/${a.id}/deactivate`,
          changeBody(1),
        ),
        post(
          w.dentist.token,
          w.patientId,
          `/alerts/${a.id}/correct`,
          changeBody(1, { severity: 'CRITICAL' }),
        ),
        post(
          w.dentist.token,
          w.patientId,
          `/alerts/${a.id}/mark-error`,
          changeBody(1),
        ),
      ]);
      expect(results.map((r) => r.status).sort((x, y) => x - y)).toEqual([200, 409, 409]);
      const rows = await ctx.db.clinicalAlert.findMany({
        where: { itemId: a.id },
      });
      expect(rows).toHaveLength(2);
      expect(rows.filter((r) => r.currentKey)).toHaveLength(1);
    });

    it('revocar la relación mientras se escribe: toda escritura confirmada quedó auditada y después de la revocación ya no hay ninguna', async () => {
      for (let round = 0; round < 4; round++) {
        const w = await world();
        const writes = Array.from({ length: 6 }, () =>
          post(w.dentist.token, w.patientId, '/history', entryBody()),
        );
        const [revoked, ...results] = await Promise.all([
          revokeCareReq(ctx, w.reception.token, w.rel.id),
          ...writes,
        ]);
        expect(revoked.status).toBe(200);
        expect(
          results.every((r) => r.status === 201 || r.status === 403),
          `ronda ${round}`,
        ).toBe(true);
        const created = results.filter((r) => r.status === 201).length;
        expect(
          await ctx.db.clinicalHistoryEntry.count({
            where: { patientId: w.patientId },
          }),
          `ronda ${round}`,
        ).toBe(created);
        expect(
          await ctx.db.auditLog.count({
            where: { patientId: w.patientId, action: 'CLINICAL_ENTRY_CREATED' },
          }),
        ).toBe(created);
        await post(
          w.dentist.token,
          w.patientId,
          '/history',
          entryBody(),
        ).expect(403); // ya revocada
        expect(
          await ctx.db.clinicalHistoryEntry.count({
            where: { patientId: w.patientId },
          }),
        ).toBe(created);
      }
    });

    it('retirar el rol o deshabilitar al odontólogo mientras escribe: nunca se escribe tras la baja y no quedan relaciones vigentes', async () => {
      for (let round = 0; round < 3; round++) {
        const w = await world();
        const assignmentId = (
          await ctx.db.userAssignment.findFirstOrThrow({
            where: { userId: w.dentist.user.id, status: 'ACTIVE' },
          })
        ).id;
        const op =
          round % 2 === 0
            ? ctx
                .http()
                .patch(`/v1/assignments/${assignmentId}/revoke`)
                .set(bearer(w.admin.token))
                .send()
            : ctx
                .http()
                .post(`/v1/users/${w.dentist.user.id}/disable`)
                .set(bearer(w.admin.token))
                .send({ reason: 'Baja del personal' });
        const [off, ...results] = await Promise.all([
          op,
          ...Array.from({ length: 5 }, () =>
            post(w.dentist.token, w.patientId, '/history', entryBody()),
          ),
        ]);
        expect(off.status).toBe(200);
        expect(
          results.every((r) => [201, 401, 403].includes(r.status)),
          `ronda ${round}`,
        ).toBe(true);
        expect(
          await ctx.db.patientCareRelationship.count({
            where: { dentistUserId: w.dentist.user.id, status: 'ACTIVE' },
          }),
        ).toBe(0);
        const after = await post(
          w.dentist.token,
          w.patientId,
          '/history',
          entryBody(),
        );
        expect([401, 403]).toContain(after.status);
      }
    });

    it('asignar la relación nunca duplica ni cruza al escribir: dos odontólogos escriben a la vez sobre el mismo paciente', async () => {
      const w = await world();
      const second = await actorIn(ctx, fx, 'DENTIST', {
        clinicId: w.clinic.id,
      });
      await assignCareReq(ctx, w.reception.token, w.patientId, {
        dentistUserId: second.user.id,
      }).expect(201);
      const e = await createEntry(w);
      const results = await Promise.all([
        post(
          w.dentist.token,
          w.patientId,
          `/history/${e.id}/rectify`,
          changeBody(1, { severity: 'MILD' }),
        ),
        post(
          second.token,
          w.patientId,
          `/history/${e.id}/rectify`,
          changeBody(1, { severity: 'MODERATE' }),
        ),
      ]);
      expect(results.map((r) => r.status).sort((x, y) => x - y)).toEqual([200, 409]);
      await chainIsSound(e.id);
    });
  });
});
