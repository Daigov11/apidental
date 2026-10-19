import { randomUUID } from 'node:crypto';
import { actorIn, bearer, createTestContext, Fixtures, type TestContext } from './helpers/app.js';

describe('Caja chica', () => {
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
    const scope = { clinicId: clinic.id, branchId: branch.id };
    const admin = await actorIn(ctx, fx, 'CLINIC_ADMIN', scope);
    const cashier = await actorIn(ctx, fx, 'CASHIER', scope);
    const reception = await actorIn(ctx, fx, 'RECEPTIONIST', scope);
    const dentist = await actorIn(ctx, fx, 'DENTIST', scope);
    const cfg = (await ctx.http().get('/v1/cashbox/config').set(bearer(cashier.token)).expect(200)).body as {
      accounts: { id: string; name: string; kind: string }[]; categories: { id: string; flow: string; name: string }[];
    };
    const acc = (name: string) => cfg.accounts.find((a) => a.name === name)!.id;
    const cat = (flow: string) => cfg.categories.find((c) => c.flow === flow)!.id;
    return { clinic, branch, admin, cashier, reception, dentist, cfg, cash: acc('Efectivo'), yape: acc('Yape / Plin'), income: cat('INCOME'), expense: cat('EXPENSE') };
  }
  type W = Awaited<ReturnType<typeof world>>;
  const api = (t: string) => ({
    get: (p: string) => ctx.http().get(`/v1/cashbox${p}`).set(bearer(t)),
    post: (p: string, b: object = {}) => ctx.http().post(`/v1/cashbox${p}`).set(bearer(t)).send(b),
    put: (p: string, b: object) => ctx.http().put(`/v1/cashbox${p}`).set(bearer(t)).send(b),
  });
  const mv = (w: W, over: Record<string, unknown> = {}) => ({
    flow: 'INCOME', accountId: w.cash, categoryId: w.income, description: 'Cobro de limpieza', amountCents: 5000, requestKey: randomUUID(), ...over,
  });
  const openWith = (w: W, cashCents = 10000) => api(w.cashier.token).post('/open', { openings: [{ accountId: w.cash, amountCents: cashCents }] });

  it('carga cuentas y tipos de operación habituales la primera vez', async () => {
    const w = await world();
    expect(w.cfg.accounts.map((a) => a.name)).toEqual(['Efectivo', 'Tarjeta', 'Yape / Plin', 'Transferencia']);
    expect(w.cfg.categories.some((c) => c.flow === 'EXPENSE')).toBe(true);
  });

  it('sin caja abierta no se registran movimientos; abrir fija el saldo inicial', async () => {
    const w = await world();
    await api(w.cashier.token).post('/movements', mv(w)).expect(409);
    await openWith(w, 10000).expect(201);
    await openWith(w).expect(409); // ya abierta
    const s = (await api(w.cashier.token).get('/summary').expect(200)).body;
    expect(s.session).toBeTruthy();
    expect(s.totals).toMatchObject({ openingCents: 10000, incomeCents: 0, expenseCents: 0, balanceCents: 10000 });
    expect(s.accounts.find((a: { name: string }) => a.name === 'Efectivo')).toMatchObject({ openingCents: 10000, balanceCents: 10000 });
  });

  it('registra ingresos y egresos, actualiza saldos por cuenta y los mantiene separados', async () => {
    const w = await world();
    await openWith(w, 10000).expect(201);
    const c = api(w.cashier.token);
    await c.post('/movements', mv(w, { amountCents: 5000 })).expect(201);
    await c.post('/movements', mv(w, { accountId: w.yape, amountCents: 3000, operationNumber: 'op-1' })).expect(201);
    await c.post('/movements', mv(w, { flow: 'EXPENSE', categoryId: w.expense, description: 'Compra de guantes', amountCents: 2000 })).expect(201);
    const s = (await c.get('/summary').expect(200)).body;
    const row = (n: string) => s.accounts.find((a: { name: string }) => a.name === n);
    expect(row('Efectivo')).toMatchObject({ incomeCents: 5000, expenseCents: 2000, balanceCents: 13000 });
    expect(row('Yape / Plin')).toMatchObject({ incomeCents: 3000, balanceCents: 3000 });
    expect(s.totals).toMatchObject({ openingCents: 10000, incomeCents: 8000, expenseCents: 2000, balanceCents: 16000 });
  });

  it('valida campos, montos positivos y coherencia del tipo de operación', async () => {
    const w = await world();
    await openWith(w).expect(201);
    const c = api(w.cashier.token);
    await c.post('/movements', mv(w, { amountCents: 0 })).expect(400);
    await c.post('/movements', mv(w, { amountCents: -5 })).expect(400);
    await c.post('/movements', mv(w, { amountCents: 12.5 })).expect(400);
    await c.post('/movements', mv(w, { description: ' ' })).expect(400);
    await c.post('/movements', mv(w, { categoryId: undefined })).expect(400);
    await c.post('/movements', mv(w, { categoryId: w.expense })).expect(422); // categoría de egreso en un ingreso
    await c.post('/movements', mv(w, { occurredAt: new Date(Date.now() + 3_600_000).toISOString() })).expect(422);
    await c.post('/movements', mv(w, { occurredAt: new Date(Date.now() - 86_400_000).toISOString() })).expect(422); // antes de la apertura
  });

  it('impide egresos superiores al saldo de la cuenta, salvo que la cuenta lo permita', async () => {
    const w = await world();
    await openWith(w, 1000).expect(201);
    const c = api(w.cashier.token);
    const over = await c.post('/movements', mv(w, { flow: 'EXPENSE', categoryId: w.expense, amountCents: 1001 })).expect(422);
    expect(over.body.code).toBe('INSUFFICIENT_BALANCE');
    await c.post('/movements', mv(w, { flow: 'EXPENSE', categoryId: w.expense, amountCents: 1000 })).expect(201);
    // el saldo de Efectivo no cubre un egreso en Yape (saldos separados)
    await c.post('/movements', mv(w, { flow: 'EXPENSE', categoryId: w.expense, accountId: w.yape, amountCents: 100 })).expect(422);
    await api(w.admin.token).put(`/accounts/${w.yape}`, { name: 'Yape / Plin', kind: 'YAPE_PLIN', allowNegative: true }).expect(200);
    await c.post('/movements', mv(w, { flow: 'EXPENSE', categoryId: w.expense, accountId: w.yape, amountCents: 100 })).expect(201);
  });

  it('evita duplicados: mismo envío y mismo número de operación', async () => {
    const w = await world();
    await openWith(w).expect(201);
    const c = api(w.cashier.token);
    const body = mv(w, { operationNumber: 'ABC-1' });
    const first = await c.post('/movements', body).expect(201);
    const retry = await c.post('/movements', body).expect(201);
    expect(retry.body.id).toBe(first.body.id);
    const dup = await c.post('/movements', mv(w, { operationNumber: 'abc-1' })).expect(409);
    expect(dup.body.code).toBe('DUPLICATE_OPERATION');
    const list = (await c.get('/movements').expect(200)).body;
    expect(list.items.filter((m: { kind: string }) => m.kind === 'NORMAL')).toHaveLength(1);
    // dos envíos simultáneos con la misma clave producen un solo movimiento
    const key = randomUUID();
    const both = await Promise.all([c.post('/movements', mv(w, { requestKey: key })), c.post('/movements', mv(w, { requestKey: key }))]);
    expect(new Set(both.map((r) => r.body.id)).size).toBe(1);
  });

  it('egresos simultáneos no pueden sobregirar la cuenta', async () => {
    const w = await world();
    await openWith(w, 1000).expect(201);
    const c = api(w.cashier.token);
    const results = await Promise.all(Array.from({ length: 4 }, () => c.post('/movements', mv(w, { flow: 'EXPENSE', categoryId: w.expense, amountCents: 600 }))));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    const s = (await c.get('/summary').expect(200)).body;
    expect(s.accounts.find((a: { name: string }) => a.name === 'Efectivo').balanceCents).toBe(400);
  });

  it('anula con motivo, recalcula el saldo y no permite dejar la cuenta en negativo', async () => {
    const w = await world();
    await openWith(w, 0).expect(201);
    const c = api(w.cashier.token);
    const inc = (await c.post('/movements', mv(w, { amountCents: 5000 })).expect(201)).body;
    const exp = (await c.post('/movements', mv(w, { flow: 'EXPENSE', categoryId: w.expense, amountCents: 4000 })).expect(201)).body;
    await c.post(`/movements/${inc.id}/void`, { reason: 'x' }).expect(400);
    await c.post(`/movements/${inc.id}/void`, { reason: 'Error de digitación' }).expect(409); // dejaría -40
    await c.post(`/movements/${exp.id}/void`, { reason: 'Error de digitación' }).expect(200);
    await c.post(`/movements/${exp.id}/void`, { reason: 'Error de digitación' }).expect(409);
    await c.post(`/movements/${inc.id}/void`, { reason: 'Error de digitación' }).expect(200);
    const s = (await c.get('/summary').expect(200)).body;
    expect(s.totals).toMatchObject({ incomeCents: 0, expenseCents: 0, balanceCents: 0 });
    const hidden = (await c.get('/movements').expect(200)).body;
    expect(hidden.items.filter((m: { kind: string }) => m.kind === 'NORMAL')).toHaveLength(0);
    const all = (await c.get('/movements?includeVoided=true').expect(200)).body;
    expect(all.items.find((m: { id: string }) => m.id === inc.id)).toMatchObject({ status: 'VOIDED', voidReason: 'Error de digitación' });
  });

  it('aplica permisos: recepción registra pero no anula ni cierra; dentista no accede', async () => {
    const w = await world();
    await openWith(w).expect(201);
    const created = (await api(w.reception.token).post('/movements', mv(w)).expect(201)).body;
    await api(w.reception.token).post(`/movements/${created.id}/void`, { reason: 'Prueba de permisos' }).expect(403);
    await api(w.reception.token).post('/close', { counts: [] }).expect(403);
    await api(w.reception.token).post('/accounts', { name: 'Caja X', kind: 'OTHER' }).expect(403);
    await api(w.cashier.token).post('/accounts', { name: 'Caja X', kind: 'OTHER' }).expect(403);
    await api(w.dentist.token).get('/summary').expect(403);
    await api(w.dentist.token).post('/movements', mv(w)).expect(403);
    await api(w.admin.token).post('/accounts', { name: 'Caja X', kind: 'OTHER' }).expect(201);
    await api(w.admin.token).post('/accounts', { name: 'Caja X', kind: 'OTHER' }).expect(409);
  });

  it('configura tipos de operación y los desactiva sin perder los movimientos', async () => {
    const w = await world();
    await openWith(w).expect(201);
    const id = (await api(w.admin.token).post('/categories', { flow: 'INCOME', name: 'Donaciones' }).expect(201)).body.id;
    await api(w.cashier.token).post('/movements', mv(w, { categoryId: id })).expect(201);
    await api(w.admin.token).put(`/categories/${id}`, { name: 'Donaciones', active: false }).expect(200);
    await api(w.cashier.token).post('/movements', mv(w, { categoryId: id })).expect(422);
    const list = (await api(w.cashier.token).get('/movements').expect(200)).body;
    expect(list.items.some((m: { category: { name: string } | null }) => m.category?.name === 'Donaciones')).toBe(true);
  });

  it('cierra con arqueo: exige el conteo, genera el ajuste y arrastra el saldo contado a la siguiente apertura', async () => {
    const w = await world();
    await openWith(w, 10000).expect(201);
    const c = api(w.cashier.token);
    await c.post('/movements', mv(w, { amountCents: 5000 })).expect(201);
    await c.post('/close', { counts: [] }).expect(422); // falta contar el efectivo
    await c.post('/close', { counts: [{ accountId: w.cash, countedCents: 14000 }] }).expect(422); // diferencia sin explicación
    const closed = (await c.post('/close', { counts: [{ accountId: w.cash, countedCents: 14000 }], notes: 'Faltan S/ 10' }).expect(200)).body;
    expect(closed.accounts.find((a: { name: string }) => a.name === 'Efectivo')).toMatchObject({ expectedCents: 15000, countedCents: 14000, differenceCents: -1000 });
    await c.post('/movements', mv(w)).expect(409); // caja cerrada
    await c.post('/close', { counts: [] }).expect(409);
    // el movimiento de una caja cerrada no se anula
    const mid = (await c.get('/movements').expect(200)).body.items.find((m: { kind: string }) => m.kind === 'NORMAL').id;
    await c.post(`/movements/${mid}/void`, { reason: 'Intento tardío' }).expect(409);

    // La siguiente apertura propone el saldo contado; cambiarlo exige explicación
    expect((await c.get('/summary').expect(200)).body.totals.balanceCents).toBe(14000);
    await c.post('/open', { openings: [{ accountId: w.cash, amountCents: 20000 }] }).expect(422);
    await c.post('/open', { openings: [{ accountId: w.cash, amountCents: 20000 }], notes: 'Se repuso fondo' }).expect(201);
    expect((await c.get('/summary').expect(200)).body.totals).toMatchObject({ openingCents: 20000, balanceCents: 20000, incomeCents: 0 });
  });

  it('filtra movimientos y genera el PDF con totales coherentes', async () => {
    const w = await world();
    await openWith(w, 10000).expect(201);
    const c = api(w.cashier.token);
    await c.post('/movements', mv(w, { amountCents: 5000 })).expect(201);
    await api(w.reception.token).post('/movements', mv(w, { accountId: w.yape, amountCents: 700 })).expect(201);
    await c.post('/movements', mv(w, { flow: 'EXPENSE', categoryId: w.expense, amountCents: 1000 })).expect(201);
    const f = async (q: string) => (await c.get(`/movements?${q}`).expect(200)).body;
    expect((await f('flow=EXPENSE')).items).toHaveLength(1);
    expect((await f(`accountId=${w.yape}`)).items).toHaveLength(1);
    expect((await f(`userId=${w.reception.user.id}`)).items).toHaveLength(1);
    const day = new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 10);
    const today = await f(`from=${day}&to=${day}&flow=INCOME`);
    expect(today).toMatchObject({ incomeCents: 5700, expenseCents: 0 });
    expect((await f('from=2020-01-01&to=2020-01-02')).items).toHaveLength(0);

    const pdf = await ctx.http().get(`/v1/cashbox/report?from=${day}&to=${day}`).set(bearer(w.cashier.token)).buffer(true)
      .parse((res, cb) => { const ch: Buffer[] = []; res.on('data', (d: Buffer) => ch.push(d)); res.on('end', () => cb(null, Buffer.concat(ch))); }).expect(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    await c.get('/report?from=2026-02-01&to=2026-01-01').expect(400);
    await c.get('/report?from=2026-01-01').expect(400);
    const audits = await ctx.db.auditLog.findMany({ where: { clinicId: w.clinic.id, action: { startsWith: 'CASH_' } } });
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(['CASH_SESSION_OPENED', 'CASH_MOVEMENT_CREATED', 'CASH_REPORT_EXPORTED']));
    expect(JSON.stringify(audits)).not.toContain('Cobro de limpieza');
  });

  it('las cajas de otra sede y de otra clínica son independientes', async () => {
    const w = await world();
    await openWith(w).expect(201);
    const other = await world();
    expect((await api(other.cashier.token).get('/summary').expect(200)).body.session).toBeNull();
    await api(other.cashier.token).post('/movements', mv(other)).expect(409);
    // un movimiento de otra clínica responde 404
    const m = (await api(w.cashier.token).post('/movements', mv(w)).expect(201)).body;
    await api(other.admin.token).post(`/movements/${m.id}/void`, { reason: 'Intento ajeno' }).expect(404);
  });
});
