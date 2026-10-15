import { actorIn, bearer, createPatient, createTestContext, Fixtures, type TestContext, uniq } from './helpers/app.js';

const DEMO_MARK = 'DEMO — NO VÁLIDO PARA SUNAT';

describe('Simuladores de Apiworking: cobros, comprobantes, cola, fidelización y reseñas (4.1)', () => {
  let ctx: TestContext;
  let fx: Fixtures;
  const before = process.env['INTEGRATIONS_MODE'];
  beforeAll(async () => {
    process.env['INTEGRATIONS_MODE'] = 'mock';
    ctx = await createTestContext();
    fx = new Fixtures(ctx.db);
  });
  afterAll(async () => {
    await ctx.close();
    if (before === undefined) delete process.env['INTEGRATIONS_MODE'];
    else process.env['INTEGRATIONS_MODE'] = before;
  });

  async function world() {
    const clinic = await fx.clinic();
    const branch = await fx.branch(clinic.id);
    const reception = await actorIn(ctx, fx, 'RECEPTIONIST', { clinicId: clinic.id });
    const cashier = await actorIn(ctx, fx, 'CASHIER', { clinicId: clinic.id });
    const admin = await actorIn(ctx, fx, 'CLINIC_ADMIN', { clinicId: clinic.id });
    const dentist = await actorIn(ctx, fx, 'DENTIST', { clinicId: clinic.id, branchId: branch.id });
    const patientId = (await createPatient(ctx, reception.token, { lastName: uniq('Paciente'), identifier: { type: 'DNI', number: String(Math.floor(1e7 + Math.random() * 9e7)) } })).id;
    const consent = (pid: string, type: 'LOYALTY' | 'MARKETING') =>
      ctx.db.patientConsent.create({ data: { clinicId: clinic.id, patientId: pid, type, activeKey: `${pid}|${type}`, grantedBy: 'PATIENT', documentTitle: 'Autorización (demo)', documentVersion: 'demo-1.0', grantedAt: new Date(), createdById: admin.user.id } });
    const room = await ctx.db.room.create({ data: { clinicId: clinic.id, branchId: branch.id, name: 'Consultorio demo' } });
    const service = await ctx.db.agendaService.create({ data: { clinicId: clinic.id, name: 'Consulta demo', durationMinutes: 30, priceCents: 12_000 } });
    const attended = (pid = patientId, status: 'ATTENDED' | 'RESERVED' = 'ATTENDED') =>
      ctx.db.appointment.create({
        data: { clinicId: clinic.id, branchId: branch.id, patientId: pid, dentistUserId: dentist.user.id, roomId: room.id, serviceId: service.id, startsAt: new Date(Math.floor((Date.now() - 3_600_000) / 300_000) * 300_000), endsAt: new Date(Math.floor((Date.now() - 1_800_000) / 300_000) * 300_000), status, createdById: reception.user.id, ...(status === 'ATTENDED' ? { attendedAt: new Date() } : {}) },
      });
    const http = (m: 'get' | 'post', t: string, p: string, b?: unknown) => (m === 'get' ? ctx.http().get(`/v1${p}`).set(bearer(t)) : ctx.http().post(`/v1${p}`).set(bearer(t)).send((b ?? {}) as object));
    const paidCharge = async (over: Record<string, unknown> = {}) => {
      const c = (await http('post', reception.token, '/billing/charges', { patientId, branchId: branch.id, description: 'Consulta de prueba', amountCents: 5_000, ...over }).expect(201)).body;
      return (await http('post', reception.token, `/billing/charges/${c.id}/pay`, { method: 'CASH', expectedVersion: c.version }).expect(200)).body;
    };
    return { clinic, branch, reception, cashier, admin, dentist, patientId, consent, attended, http, paidCharge, service };
  }

  it('el modo off no expone cobros ni comprobantes y no hay simulación', async () => {
    process.env['INTEGRATIONS_MODE'] = 'off';
    const off = await createTestContext();
    try {
      const f = new Fixtures(off.db);
      const clinic = await f.clinic();
      const cashier = await actorIn(off, f, 'CASHIER', { clinicId: clinic.id });
      const st = await off.http().get('/v1/integrations/status').set(bearer(cashier.token)).expect(200);
      expect(st.body).toMatchObject({ mode: 'off', simulation: null });
      const res = await off.http().get('/v1/billing/charges').set(bearer(cashier.token));
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('INTEGRATIONS_DISABLED');
      await off.http().get('/v1/reviews/summary').set(bearer(cashier.token)).expect(503);
    } finally {
      await off.close();
      process.env['INTEGRATIONS_MODE'] = 'mock';
    }
  });

  it('el modo mock avisa siempre que es una simulación', async () => {
    const w = await world();
    const st = (await w.http('get', w.reception.token, '/integrations/status').expect(200)).body;
    expect(st.mode).toBe('mock');
    expect(st.simulation).toMatchObject({ active: true, demoMark: DEMO_MARK });
    expect(st.simulation.label).toMatch(/SIMULACIÓN/);
    expect(st.scenarios.map((s: { code: string }) => s.code)).toEqual(['ISSUE', 'PENDING', 'REJECT', 'ERROR_THEN_OK', 'TIMEOUT']);
  });

  it('cobro: desde una cita atendida (precio del servicio), validaciones, aislamiento y permisos', async () => {
    const w = await world();
    const appt = await w.attended();
    const c = (await w.http('post', w.reception.token, '/billing/charges', { patientId: w.patientId, appointmentId: appt.id }).expect(201)).body;
    expect(c).toMatchObject({ description: 'Consulta demo', amountCents: 12_000, amountText: 'S/ 120.00', status: 'PENDING', statusLabel: 'Pendiente de pago' });
    expect(c.actions).toMatchObject({ pay: true, void: true, emitDocument: false });
    expect((await w.http('post', w.reception.token, '/billing/charges', { patientId: w.patientId, appointmentId: appt.id })).body.code).toBe('CHARGE_EXISTS');
    const open = await w.attended(w.patientId, 'RESERVED');
    expect((await w.http('post', w.reception.token, '/billing/charges', { patientId: w.patientId, appointmentId: open.id })).body.code).toBe('APPOINTMENT_NOT_ATTENDED');
    await w.http('post', w.reception.token, '/billing/charges', { patientId: w.patientId, description: 'Sin sede' }).expect(400);
    await w.http('post', w.dentist.token, '/billing/charges', { patientId: w.patientId, description: 'x y z', amountCents: 100 }).expect(403);
    // anular un cobro pendiente libera la cita para cobrarla de nuevo
    await w.http('post', w.reception.token, `/billing/charges/${c.id}/void`, { reason: 'x', expectedVersion: c.version }).expect(400);
    const voided = (await w.http('post', w.reception.token, `/billing/charges/${c.id}/void`, { reason: 'Se registró por error', expectedVersion: c.version }).expect(200)).body;
    expect(voided.status).toBe('VOIDED');
    await w.http('post', w.reception.token, '/billing/charges', { patientId: w.patientId, appointmentId: appt.id }).expect(201);
    // otra clínica: 404 uniforme
    const other = await world();
    await other.http('get', other.cashier.token, `/billing/charges/${c.id}`).expect(404);
    expect((await other.http('get', other.cashier.token, '/billing/charges').expect(200)).body).toEqual([]);
  });

  it('pago: versión, doble pago concurrente y mensajes encolados en la misma transacción', async () => {
    const w = await world();
    const c = (await w.http('post', w.cashier.token, '/billing/charges', { patientId: w.patientId, description: 'Limpieza', amountCents: 8_000, branchId: w.branch.id }).expect(201)).body;
    const stale = await w.http('post', w.cashier.token, `/billing/charges/${c.id}/pay`, { method: 'CARD', expectedVersion: 99 });
    expect(stale.body.code).toBe('VERSION_CONFLICT');
    const two = await Promise.all([1, 2].map(() => w.http('post', w.cashier.token, `/billing/charges/${c.id}/pay`, { method: 'CARD', expectedVersion: c.version })));
    expect(two.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 409]);
    const paid = two.find((r) => r.status === 200)!.body;
    expect(paid).toMatchObject({ status: 'PAID', paymentMethodLabel: 'Tarjeta' });
    expect(paid.actions).toMatchObject({ pay: false, void: false, emitDocument: true });
    const queued = await ctx.db.integrationOutbox.findMany({ where: { aggregateId: c.id }, orderBy: { kind: 'asc' } });
    expect(queued.map((q) => q.kind).sort()).toEqual(['LOYALTY_ACCRUE', 'REVIEW_REQUEST']);
    expect(queued.every((q) => q.status === 'PENDING')).toBe(true);
    expect((await w.http('post', w.cashier.token, `/billing/charges/${c.id}/void`, { reason: 'ya pagado', expectedVersion: paid.version })).body.code).toBe('INVALID_TRANSITION');
  });

  it('comprobante emitido: marca DEMO visible, numeración, instantáneo del cliente, PDF y una sola emisión ante doble clic', async () => {
    const w = await world();
    const c = await w.paidCharge();
    expect((await w.http('post', w.reception.token, `/billing/charges/${c.id}/document`, { type: 'BOLETA' })).status).toBe(403); // recepción no emite
    const both = await Promise.all([1, 2].map(() => w.http('post', w.cashier.token, `/billing/charges/${c.id}/document`, { type: 'BOLETA' })));
    expect(both.map((r) => r.status).sort((a, b) => a - b)).toEqual([201, 409]);
    expect(both.find((r) => r.status === 409)!.body.code).toBe('DOCUMENT_EXISTS');
    const doc = both.find((r) => r.status === 201)!.body;
    expect(doc).toMatchObject({ status: 'ISSUED', statusLabel: 'Emitido', demoMark: DEMO_MARK, simulated: true, type: 'BOLETA', amountText: 'S/ 50.00' });
    expect(doc.number).toMatch(/^BD01-\d{8}$/);
    expect(doc.providerRef).toMatch(/^DEMO-/);
    expect(doc.customer.docType).toBe('DNI');
    expect(await ctx.db.billingDocument.count({ where: { chargeId: c.id } })).toBe(1);
    expect(await ctx.db.mockProviderRecord.count({ where: { idempotencyKey: { startsWith: `doc:${c.id}` } } })).toBe(1);
    // numeración correlativa
    const c2 = await w.paidCharge({ description: 'Otra' });
    const d2 = (await w.http('post', w.cashier.token, `/billing/charges/${c2.id}/document`, { type: 'BOLETA' }).expect(201)).body;
    expect(Number(d2.number.slice(-8))).toBe(Number(doc.number.slice(-8)) + 1);
    // PDF descargable y auditado
    const pdf = await ctx.http().get(`/v1/billing/documents/${doc.id}/pdf`).set(bearer(w.cashier.token)).buffer(true).parse((res, cb) => { const ch: Buffer[] = []; res.on('data', (d: Buffer) => ch.push(d)); res.on('end', () => cb(null, Buffer.concat(ch))); }).expect(200);
    expect(pdf.headers['content-type']).toMatch(/pdf/);
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    expect(pdf.headers['content-disposition']).toMatch(/comprobante-demo-BD01-/);
    for (const a of ['DOCUMENT_QUEUED', 'DOCUMENT_ISSUED', 'DOCUMENT_PDF_DOWNLOADED']) expect((await ctx.db.auditLog.findMany({ where: { action: a, entityId: doc.id } })).length, a).toBeGreaterThan(0);
    // el cobro sin pagar no admite comprobante; la factura exige RUC y razón social
    const unpaid = (await w.http('post', w.cashier.token, '/billing/charges', { patientId: w.patientId, description: 'Pendiente', amountCents: 1_000, branchId: w.branch.id }).expect(201)).body;
    expect((await w.http('post', w.cashier.token, `/billing/charges/${unpaid.id}/document`, { type: 'BOLETA' })).body.code).toBe('CHARGE_NOT_PAID');
    const c3 = await w.paidCharge({ description: 'Factura demo' });
    await w.http('post', w.cashier.token, `/billing/charges/${c3.id}/document`, { type: 'FACTURA' }).expect(400);
    const f = (await w.http('post', w.cashier.token, `/billing/charges/${c3.id}/document`, { type: 'FACTURA', customerRuc: '20000000001', customerName: 'Empresa Demo S.A.C. (ficticia)' }).expect(201)).body;
    expect(f.number).toMatch(/^FD01-/);
    expect(f.customer).toMatchObject({ docType: 'RUC', docNumber: '20000000001' });
  });

  it('rechazo: queda definitivo y se emite otro comprobante nuevo con otra clave y otro número', async () => {
    const w = await world();
    const c = await w.paidCharge();
    const rej = (await w.http('post', w.cashier.token, `/billing/charges/${c.id}/document`, { type: 'BOLETA', scenario: 'REJECT' }).expect(201)).body;
    expect(rej).toMatchObject({ status: 'REJECTED', statusLabel: 'Rechazado', demoMark: DEMO_MARK });
    expect(rej.rejectionReason).toMatch(/simulado/i);
    expect(rej.actions).toMatchObject({ retry: false, reconcile: false });
    expect((await w.http('post', w.cashier.token, `/billing/documents/${rej.id}/retry`)).body.code).toBe('INVALID_TRANSITION');
    const again = (await w.http('post', w.cashier.token, `/billing/charges/${c.id}/document`, { type: 'BOLETA' }).expect(201)).body;
    expect(again.status).toBe('ISSUED');
    expect(again.number).not.toBe(rej.number);
    const keys = (await ctx.db.billingDocument.findMany({ where: { chargeId: c.id }, orderBy: { number: 'asc' } })).map((d) => d.idempotencyKey);
    expect(keys).toEqual([`doc:${c.id}:1`, `doc:${c.id}:2`]);
  });

  it('error reintentable: se reintenta con LA MISMA clave y no se duplica', async () => {
    const w = await world();
    const c = await w.paidCharge();
    const d = (await w.http('post', w.cashier.token, `/billing/charges/${c.id}/document`, { type: 'BOLETA', scenario: 'ERROR_THEN_OK' }).expect(201)).body;
    expect(d).toMatchObject({ status: 'RETRYABLE_ERROR', statusLabel: 'Error reintentable', attempts: 1 });
    expect(d.actions.retry).toBe(true);
    const item = await ctx.db.integrationOutbox.findFirstOrThrow({ where: { aggregateId: d.id } });
    expect(item.status).toBe('PENDING'); // sigue en cola con espera creciente
    const ok = (await w.http('post', w.cashier.token, `/billing/documents/${d.id}/retry`).expect(200)).body;
    expect(ok).toMatchObject({ status: 'ISSUED', attempts: 2 });
    expect(await ctx.db.mockProviderRecord.count({ where: { idempotencyKey: `doc:${c.id}:1` } })).toBe(1);
    expect((await ctx.db.integrationOutbox.findUniqueOrThrow({ where: { id: item.id } })).status).toBe('DONE');
    // repetir el reintento ya no hace nada
    expect((await w.http('post', w.cashier.token, `/billing/documents/${d.id}/retry`)).status).toBe(409);
  });

  it('pendiente y sin respuesta a tiempo: se concilian con el proveedor por la clave de idempotencia', async () => {
    const w = await world();
    const c1 = await w.paidCharge();
    const pending = (await w.http('post', w.cashier.token, `/billing/charges/${c1.id}/document`, { type: 'BOLETA', scenario: 'PENDING' }).expect(201)).body;
    expect(pending).toMatchObject({ status: 'SENT', statusLabel: 'Enviado' });
    expect(pending.actions.reconcile).toBe(true);
    expect((await w.http('post', w.cashier.token, `/billing/documents/${pending.id}/reconcile`).expect(200)).body.status).toBe('ISSUED');

    const c2 = await w.paidCharge();
    const timeout = (await w.http('post', w.cashier.token, `/billing/charges/${c2.id}/document`, { type: 'BOLETA', scenario: 'TIMEOUT' }).expect(201)).body;
    expect(timeout).toMatchObject({ status: 'NEEDS_RECONCILIATION', statusLabel: 'Requiere conciliación' });
    // el proveedor SÍ lo procesó: conciliar lo emite sin duplicar
    expect((await w.http('post', w.cashier.token, `/billing/documents/${timeout.id}/reconcile`).expect(200)).body.status).toBe('ISSUED');
    expect(await ctx.db.mockProviderRecord.count({ where: { idempotencyKey: `doc:${c2.id}:1` } })).toBe(1);

    // el proveedor NUNCA lo recibió: conciliar lo reenvía (misma clave) y se emite
    const c3 = await w.paidCharge();
    const lost = (await w.http('post', w.cashier.token, `/billing/charges/${c3.id}/document`, { type: 'BOLETA', scenario: 'TIMEOUT' }).expect(201)).body;
    await ctx.db.mockProviderRecord.delete({ where: { idempotencyKey: `doc:${c3.id}:1` } });
    const fixed = (await w.http('post', w.cashier.token, `/billing/documents/${lost.id}/reconcile`).expect(200)).body;
    expect(fixed.status).toBe('ISSUED');
    // conciliar lo ya emitido no corresponde
    expect((await w.http('post', w.cashier.token, `/billing/documents/${fixed.id}/reconcile`)).status).toBe(409);
    // conciliación masiva
    const c4 = await w.paidCharge();
    await w.http('post', w.cashier.token, `/billing/charges/${c4.id}/document`, { type: 'BOLETA', scenario: 'PENDING' }).expect(201);
    const all = (await w.http('post', w.admin.token, '/billing/reconcile').expect(200)).body;
    expect(all.checked).toBe(1);
    expect(all.results).toEqual({ ISSUED: 1 });
    expect((await w.http('get', w.admin.token, '/billing/documents?status=ISSUED').expect(200)).body.length).toBeGreaterThanOrEqual(4);
  });

  it('la base de datos exige la marca DEMO y protege cobros y comprobantes', async () => {
    const w = await world();
    const c = await w.paidCharge();
    const d = (await w.http('post', w.cashier.token, `/billing/charges/${c.id}/document`, { type: 'BOLETA' }).expect(201)).body;
    const base = { clinicId: w.clinic.id, chargeId: c.id, type: 'BOLETA' as const, series: 'BX99', number: 1, customerName: 'x', customerDocType: 'DNI', customerDocNumber: '1', amountCents: 100, igvCents: 15, createdById: w.cashier.user.id };
    await expect(ctx.db.billingDocument.create({ data: { ...base, demoMark: 'VÁLIDO', idempotencyKey: uniq('k') } })).rejects.toThrow();
    await expect(ctx.db.billingDocument.create({ data: { ...base, demoMark: DEMO_MARK, idempotencyKey: uniq('k') } })).resolves.toBeTruthy();
    await expect(ctx.db.$executeRaw`UPDATE billing_documents SET customer_name = 'otro' WHERE id = ${d.id}`).rejects.toThrow();
    await expect(ctx.db.$executeRaw`UPDATE billing_documents SET status = 'PENDING_SEND' WHERE id = ${d.id}`).rejects.toThrow();
    await expect(ctx.db.$executeRaw`DELETE FROM billing_documents WHERE id = ${d.id}`).rejects.toThrow();
    await expect(ctx.db.$executeRaw`UPDATE charges SET amount_cents = 1 WHERE id = ${c.id}`).rejects.toThrow();
    await expect(ctx.db.$executeRaw`UPDATE charges SET status = 'PENDING' WHERE id = ${c.id}`).rejects.toThrow();
    await expect(ctx.db.$executeRaw`DELETE FROM charges WHERE id = ${c.id}`).rejects.toThrow();
  });

  it('fidelización: acumula al pagar con autorización, canjea con idempotencia y muestra el resumen NFC simulado', async () => {
    const w = await world();
    await w.consent(w.patientId, 'LOYALTY');
    const c = await w.paidCharge({ amountCents: 12_500 }); // S/ 125 → 12 puntos
    const run = (await w.http('post', w.cashier.token, '/billing/outbox/process').expect(200)).body;
    expect(run).toMatchObject({ processed: 2, done: 1, skipped: 1 }); // puntos; la reseña se omite (sin autorización de marketing)
    const s = (await w.http('get', w.cashier.token, `/loyalty/patients/${w.patientId}`).expect(200)).body;
    expect(s.simulation.label).toMatch(/SIMULACIÓN/);
    expect(s.consent).toBe('GRANTED');
    expect(s.points).toMatchObject({ balance: 12, accrued: 12, redeemed: 0, tier: 'Bronce (simulado)' });
    expect(s.nfc.cardLabel).toMatch(/DEMO/);
    expect(s.nfc.status).toMatch(/simulada/);
    // procesar de nuevo no acumula dos veces (idempotencia)
    expect((await w.http('post', w.cashier.token, '/billing/outbox/process').expect(200)).body.processed).toBe(0);
    expect((await w.http('get', w.cashier.token, `/loyalty/patients/${w.patientId}`).expect(200)).body.points.balance).toBe(12);
    // canje
    const requestId = '11111111-1111-4111-8111-111111111111';
    expect((await w.http('post', w.cashier.token, `/loyalty/patients/${w.patientId}/redeem`, { points: 50 })).body.code).toBe('INSUFFICIENT_POINTS');
    const r1 = (await w.http('post', w.cashier.token, `/loyalty/patients/${w.patientId}/redeem`, { points: 5, requestId }).expect(200)).body;
    const r2 = (await w.http('post', w.cashier.token, `/loyalty/patients/${w.patientId}/redeem`, { points: 5, requestId }).expect(200)).body;
    expect([r1.balance, r2.balance]).toEqual([7, 7]);
    expect((await ctx.db.mockLoyaltyEntry.count({ where: { patientRef: w.patientId, kind: 'REDEMPTION' } }))).toBe(1);
    await w.http('post', w.reception.token, `/loyalty/patients/${w.patientId}/redeem`, { points: 1 }).expect(403); // recepción solo consulta
    expect((await w.http('get', w.reception.token, `/loyalty/patients/${w.patientId}`).expect(200)).body.points.balance).toBe(7);
    await w.http('get', w.dentist.token, `/loyalty/patients/${w.patientId}`).expect(403);
    expect((await ctx.db.auditLog.findMany({ where: { action: 'LOYALTY_REDEEMED', patientId: w.patientId } })).length).toBe(2);
    expect(c.status).toBe('PAID');
  });

  it('sin autorización del paciente no se acumulan ni se muestran puntos, y no se piden reseñas', async () => {
    const w = await world();
    await w.paidCharge({ amountCents: 20_000 });
    const run = (await w.http('post', w.cashier.token, '/billing/outbox/process').expect(200)).body;
    expect(run).toMatchObject({ processed: 2, skipped: 2, done: 0 });
    const items = await ctx.db.integrationOutbox.findMany({ where: { clinicId: w.clinic.id } });
    expect(items.every((i) => i.status === 'SKIPPED' && /Sin autorización/.test(i.note ?? ''))).toBe(true);
    const s = (await w.http('get', w.cashier.token, `/loyalty/patients/${w.patientId}`).expect(200)).body;
    expect(s).toMatchObject({ consent: 'MISSING' });
    expect(s.points).toBeUndefined();
    expect((await w.http('post', w.cashier.token, `/loyalty/patients/${w.patientId}/redeem`, { points: 1 })).body.code).toBe('NO_LOYALTY_CONSENT');
    expect(await ctx.db.mockLoyaltyEntry.count({ where: { clinicId: w.clinic.id } })).toBe(0);
    expect(await ctx.db.mockReviewRequest.count({ where: { clinicId: w.clinic.id } })).toBe(0);
  });

  it('reseñas simuladas: solicitud con autorización de marketing y resumen ficticio marcado', async () => {
    const w = await world();
    await w.consent(w.patientId, 'MARKETING');
    await w.paidCharge();
    await w.http('post', w.cashier.token, '/billing/outbox/process').expect(200);
    const r = (await w.http('get', w.cashier.token, '/reviews/summary').expect(200)).body;
    expect(r.simulation.active).toBe(true);
    expect(r).toMatchObject({ average: 4.6, total: 128, requestsSent: 1 });
    expect(r.recent.every((x: { label: string }) => /ficticio/.test(x.label))).toBe(true);
    const other = await world();
    expect((await other.http('get', other.cashier.token, '/reviews/summary').expect(200)).body.requestsSent).toBe(0);
  });

  it('cola: lista con referencias legibles, aislada por clínica; la salida no incluye datos clínicos ni secretos', async () => {
    const w = await world();
    const c = await w.paidCharge();
    await w.http('post', w.cashier.token, `/billing/charges/${c.id}/document`, { type: 'BOLETA' }).expect(201);
    const q = (await w.http('get', w.admin.token, '/billing/outbox').expect(200)).body;
    expect(q.map((i: { kindLabel: string }) => i.kindLabel).sort()).toEqual(['Emisión de comprobante', 'Puntos de fidelización', 'Solicitud de reseña']);
    const emit = q.find((i: { kind: string }) => i.kind === 'BILLING_EMIT');
    expect(emit).toMatchObject({ status: 'DONE', statusLabel: 'Procesado' });
    expect(emit.reference).toMatch(/^BD01-/);
    expect(JSON.stringify(q)).not.toMatch(/token|password|secret|diagn|evoluci/i);
    const other = await world();
    expect((await other.http('get', other.admin.token, '/billing/outbox').expect(200)).body).toEqual([]);
    await other.http('post', other.cashier.token, `/billing/documents/${emit.id}/reconcile`).expect(404);
  });

  it('aislamiento: un comprobante de otra clínica responde 404 y los permisos de lectura no permiten emitir', async () => {
    const w = await world();
    const c = await w.paidCharge();
    const d = (await w.http('post', w.cashier.token, `/billing/charges/${c.id}/document`, { type: 'BOLETA' }).expect(201)).body;
    const other = await world();
    for (const p of [`/billing/documents/${d.id}`, `/billing/documents/${d.id}/pdf`]) expect((await other.http('get', other.cashier.token, p)).status).toBe(404);
    await other.http('post', other.cashier.token, `/billing/charges/${c.id}/document`, { type: 'BOLETA' }).expect(404);
    await w.http('get', w.reception.token, `/billing/documents/${d.id}`).expect(200); // recepción puede consultar
    await w.http('post', w.admin.token, `/billing/charges/${c.id}/document`, { type: 'BOLETA' }).expect(409); // admin puede emitir, pero ya existe
  });
});
