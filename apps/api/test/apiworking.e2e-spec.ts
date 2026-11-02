import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { ApiworkingSessionStore } from '../src/apiworking/apiworking-session.store.js';
import { bearer, createTestContext, Fixtures, type TestContext } from './helpers/app.js';

const TENANT = 'prod_ti_tiendaglowsmile';
const jwt = (exp: number) => `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.firma`;
const EXTERNAL_TOKEN = jwt(Math.floor(Date.now() / 1000) + 3600);

interface Seen { method: string; path: string; query: URLSearchParams; auth: string | undefined; body: Record<string, unknown> | null }

describe('Apiworking real: login, clientes y ventas por registro-documento (servidor simulado)', () => {
  let ctx: TestContext;
  let fx: Fixtures;
  let fake: Server;
  const seen: Seen[] = [];
  const saved: Record<string, string | undefined> = {};
  /** Escenarios que la prueba activa en el servidor simulado. */
  const scenario = { registro: 'ok' as 'ok' | 'reject' | 'boom' | 'incomplete', pagos: 'none' as 'none' | 'paid', tenant: TENANT, cajaOpen: true, apertura: 'ok' as 'ok' | 'boom' | 'reject' };

  const customers = [
    { total: 3, id_cliente: 202600000038, id_persona: 202600000049, nombrecompleto: 'ROBERTO CARLOS ESPINAR VICHARRA', email: '', tipoDoc: 'D.N.I.', numerodocumento: '74908568', telefono: '', tipo_persona: 'N', estado: 'A', limite_credito: '0.00', saldo: 0, whatsapp: '', saldo_restante: '0.00' },
    { total: 3, id_cliente: 202600000040, id_persona: 202600000051, nombrecompleto: 'CLINICA SONRISA SAC', email: 'a@b.pe', tipoDoc: 'R.U.C.', numerodocumento: '20123456789', telefono: '999', tipo_persona: 'J', estado: 'A', limite_credito: '0.00', saldo: 0, whatsapp: '', saldo_restante: '0.00' },
    { total: 3, id_cliente: 202600000041, id_persona: 202600000052, nombrecompleto: 'CLIENTE INACTIVO', email: '', tipoDoc: 'D.N.I.', numerodocumento: '11111111', telefono: '', tipo_persona: 'N', estado: 'I', limite_credito: '0.00', saldo: 0, whatsapp: '', saldo_restante: '0.00' },
  ];

  const ok = (data: unknown) => ({ codResponse: 1, message: 'OK', data });

  function route(req: Seen): { status: number; body?: unknown; hang?: boolean } {
    if (req.method === 'POST' && req.path === `/api/CajaChica/AperturaCajaChica/${TENANT}`) {
      if (scenario.apertura === 'boom') return { status: 500, body: { error: 'x' } };
      if (scenario.apertura === 'reject') return { status: 200, body: { codResponse: 0, message: 'Turno inválido' } };
      scenario.cajaOpen = true;
      return { status: 200, body: ok([{ result: 3, duplicado: 1 }]) };
    }
    switch (`${req.method} ${req.path}`) {
      case 'POST /api/User/login': {
        const b = req.body ?? {};
        if (b['password'] !== 'clave-correcta') return { status: 200, body: { codResponse: 0, message: 'Usuario o contraseña incorrectos' } };
        return { status: 200, body: ok({ token: EXTERNAL_TOKEN, id_usuario: 77, id_persona: 201900000001, usuario: b['usuario'], nombrecompleto: 'GINA PAREDES YAURI', id_sucursal: 1, roles: ['ADMIN'], empresa: { base_datos: scenario.tenant } }) };
      }
      case 'GET /api/Caja': return { status: 200, body: ok([{ idCaja: 5, caja: 'Caja Glow', sucursal: 'Principal' }, { idCaja: 6, caja: 'Caja ajena', sucursal: 'Otra' }]) };
      case 'GET /api/CajaChica/consulta-aperturada': return { status: 200, body: ok(scenario.cajaOpen ? { id_movimiento_caja: 9001 } : []) };
      case 'GET /api/CajaChica/turnos': return { status: 200, body: ok([{ idTurno: 1, turno: 'Mañana' }, { idTurno: 2, turno: 'Tarde' }]) };
      case 'GET /api/Caja/tipo-documentos': return { status: 200, body: ok([{ id_tipo_documento: 2, tipo_documento: 'Boleta' }, { id_tipo_documento: 9, tipo_documento: 'No autorizado' }]) };
      case 'GET /api/Facturacion/series': return { status: 200, body: ok([{ id_serie: 11, serie: 'B001' }, { id_serie: 12, serie: 'B002' }]) };
      case 'GET /api/CajaChica/formas-pago': return { status: 200, body: ok([{ id_metodo_pago: 1, metodoPago: 'Efectivo' }]) };
      case 'GET /api/Cliente/clientes': return { status: 200, body: ok(customers) };
      case 'POST /api/Facturacion/registro-documento':
        if (scenario.registro === 'boom') return { status: 500, body: { error: 'x' } };
        if (scenario.registro === 'reject') return { status: 200, body: { codResponse: 0, message: 'Serie sin correlativo' } };
        if (scenario.registro === 'incomplete') return { status: 200, body: ok({ result: 0, error: 'algo' }) };
        return { status: 200, body: ok({ result: 1, error: null, idComprobante: 201900000123, nroComprobante: 'B001-00000123' }) };
      case 'GET /api/Facturacion/controlPagos':
        return scenario.pagos === 'paid' ? { status: 200, body: ok([{ metodopago: 'Efectivo', importe: '1,000.00', estado: 'P' }]) } : { status: 200, body: { codResponse: 0, message: 'No se pudo encontrar pagos' } };
      case 'GET /api/Facturacion': return { status: 200, body: ok([{ nroComprobante: 'B001-00000123', estado: scenario.registro === 'ok' ? 'ANULADO' : 'EMITIDO', totalVenta: '100.00', monto_saldo: '100.00', metodospagos: '' }]) };
      case 'POST /api/Facturacion/anular': return { status: 200, body: ok({ result: 1 }) };
      default: return { status: 404 };
    }
  }

  beforeAll(async () => {
    fake = createServer((req: IncomingMessage, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const url = new URL(req.url ?? '/', 'http://x');
        const raw = Buffer.concat(chunks).toString('utf8');
        const entry: Seen = { method: req.method ?? 'GET', path: url.pathname, query: url.searchParams, auth: req.headers.authorization, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : null };
        seen.push(entry);
        const out = route(entry);
        res.writeHead(out.status, { 'content-type': 'application/json' });
        res.end(out.body === undefined ? '' : JSON.stringify(out.body));
      });
    });
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
    const env: Record<string, string> = {
      AUTH_MODE: 'apiworking',
      APIWORKING_BASE_URL: `http://127.0.0.1:${(fake.address() as AddressInfo).port}`,
      APIWORKING_SYSTEM_ID: 'https://tiendaglowsmile.apiworking.co/',
      APIWORKING_AUTHZ_EXPECTED_DATABASE: TENANT,
      APIWORKING_AUTHZ_READ: 'true',
      APIWORKING_AUTHZ_WRITE: 'true',
      APIWORKING_MAX_REAL_OPERATIONS: '4',
      APIWORKING_AUTHORIZED_CASH_REGISTERS: '5',
      APIWORKING_AUTHORIZED_DOCUMENT_TYPES: '2',
      APIWORKING_AUTHORIZED_SERIES: '11',
      APIWORKING_WAREHOUSE_ID: '1',
      APIWORKING_UNIT_ID: '15',
    };
    for (const [k, v] of Object.entries(env)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    ctx = await createTestContext();
    fx = new Fixtures(ctx.db);
  });

  afterAll(async () => {
    await ctx.close();
    await new Promise((r) => fake.close(r));
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const cookies = (res: { headers: Record<string, unknown> }) => [res.headers['set-cookie']].flat().join(';');

  const draft = (over: Record<string, unknown> = {}) => ({
    customerId: '202600000038',
    idCaja: '5',
    idTipoDocumento: '2',
    idSerie: '11',
    idMetodoPago: '1',
    description: 'Limpieza dental',
    lines: [{ name: 'Profilaxis', quantity: 2, unitPriceCents: 5000 }],
    docDate: '2026-11-02',
    ...over,
  });

  let token = '';
  let clinicId = '';
  let userId = '';

  async function enter(usuario = 'gina') {
    const res = await ctx.http().post('/v1/auth/apiworking-login').send({ usuario, password: 'clave-correcta' }).expect(200);
    return res.body as { accessToken: string; pendingAccess: boolean; contexts: unknown[]; user: { id: string } };
  }

  it('expone el modo de acceso y rechaza credenciales, tenant ajeno y token ausente sin filtrar nada', async () => {
    expect((await ctx.http().get('/v1/auth/config').expect(200)).body).toEqual({ mode: 'apiworking' });

    await ctx.http().post('/v1/auth/apiworking-login').send({ usuario: 'gina', password: 'mala' }).expect(401);
    scenario.tenant = 'prod_ti_otro_cliente';
    const other = await ctx.http().post('/v1/auth/apiworking-login').send({ usuario: 'gina', password: 'clave-correcta' });
    expect(other.status).toBe(401);
    expect(other.body.message).toBe('Credenciales inválidas');
    scenario.tenant = TENANT;
    expect(await ctx.db.externalIdentity.count()).toBe(0);
  });

  it('el login crea un usuario local SIN roles, envía idSistema y guarda el JWT externo solo en memoria', async () => {
    const res = await ctx.http().post('/v1/auth/apiworking-login').send({ usuario: 'gina', password: 'clave-correcta' }).expect(200);
    expect(res.body.pendingAccess).toBe(true);
    expect(res.body.contexts).toEqual([]);
    expect(cookies(res)).toMatch(/apidental_rt=/);
    // El JWT externo nunca llega al navegador: ni en el cuerpo ni en cookies.
    expect(JSON.stringify(res.body)).not.toContain(EXTERNAL_TOKEN);
    expect(cookies(res)).not.toContain(EXTERNAL_TOKEN);

    const login = seen.find((s) => s.path === '/api/User/login' && (s.body?.['password'] === 'clave-correcta'))!;
    expect(login.body).toMatchObject({ usuario: 'gina', idSistema: 'https://tiendaglowsmile.apiworking.co/' });
    expect(login.auth).toBeUndefined();

    const identity = await ctx.db.externalIdentity.findFirstOrThrow({ include: { user: true } });
    expect(identity).toMatchObject({ provider: 'APIWORKING', tenant: TENANT, externalUserId: '77', externalUsername: 'gina' });
    expect(identity.user.firstName).toBe('GINA');
    userId = identity.userId;
    const assignments = await ctx.db.userAssignment.count({ where: { userId } });
    expect(assignments).toBe(0);

    // Un segundo ingreso reutiliza el mismo usuario.
    await enter();
    expect(await ctx.db.externalIdentity.count()).toBe(1);

    // La cuenta no tiene contraseña local utilizable.
    await ctx.http().post('/v1/auth/login').send({ email: identity.user.email, password: 'clave-correcta' }).expect(401);
  });

  it('sin rol local no opera; con rol, lista clientes activos y filtra por texto', async () => {
    const first = await enter();
    await ctx.http().get('/v1/apiworking/clients').set(bearer(first.accessToken)).expect(403);

    clinicId = (await fx.clinic()).id;
    await fx.assign(userId, 'CLINIC_ADMIN', { clinicId });
    const again = await enter();
    expect(again.pendingAccess).toBe(false);
    const sel = await ctx.http().post('/v1/auth/select-context').set(bearer(again.accessToken)).send({ clinicId, branchId: null }).expect(200);
    token = sel.body.accessToken;

    const status = await ctx.http().get('/v1/apiworking/status').set(bearer(token)).expect(200);
    expect(status.body).toMatchObject({ configured: true, read: true, write: true, tenant: TENANT, session: true });

    const list = await ctx.http().get('/v1/apiworking/clients').set(bearer(token)).expect(200);
    expect(list.body.total).toBe(2); // el cliente inactivo no se lista
    expect(list.body.items.map((c: { name: string }) => c.name)).toEqual(['CLINICA SONRISA SAC', 'ROBERTO CARLOS ESPINAR VICHARRA']); // ordenados por nombre
    expect(list.body.items[1]).toMatchObject({ id: '202600000038', docType: 'D.N.I.', docNumber: '74908568' });
    const q = await ctx.http().get('/v1/apiworking/clients?search=sonrisa').set(bearer(token)).expect(200);
    expect(q.body.items.map((c: { name: string }) => c.name)).toEqual(['CLINICA SONRISA SAC']);

    const call = seen.filter((s) => s.path === '/api/Cliente/clientes').at(-1)!;
    expect(call.query.get('bd')).toBe(TENANT);
    expect(call.query.get('displayLength')).toBe('1000');
    expect(call.auth).toBe(`Bearer ${EXTERNAL_TOKEN}`);
  });

  it('el contexto de ventas solo muestra caja, tipo y serie autorizados', async () => {
    const c = await ctx.http().get('/v1/apiworking/sales/context?idCaja=5&idTipoDocumento=2').set(bearer(token)).expect(200);
    expect(c.body.cajas.map((x: { id: string }) => x.id)).toEqual(['5']);
    expect(c.body.documentTypes.map((x: { id: string }) => x.id)).toEqual(['2']);
    expect(c.body.series).toEqual([{ id: '11', serie: 'B001' }]);
    expect(c.body.paymentMethods).toEqual([{ id: '1', name: 'Efectivo' }]);
    await ctx.http().get('/v1/apiworking/sales/context?idCaja=6').set(bearer(token)).expect(400);
  });

  it('el descubrimiento muestra TODO lo que informa Apiworking, marcando lo autorizado, y solo al administrador', async () => {
    const d = await ctx.http().get('/v1/apiworking/discovery?idCaja=5&idTipoDocumento=2').set(bearer(token)).expect(200);
    expect(d.body.cajas).toEqual([
      { id: '5', name: 'Caja Glow', branch: 'Principal', authorized: true },
      { id: '6', name: 'Caja ajena', branch: 'Otra', authorized: false },
    ]);
    expect(d.body.documentTypes).toEqual([{ id: '2', name: 'Boleta', authorized: true }, { id: '9', name: 'No autorizado', authorized: false }]);
    expect(d.body.series).toEqual([{ id: '11', serie: 'B001', authorized: true }, { id: '12', serie: 'B002', authorized: false }]);
    expect(d.body).toMatchObject({ opened: true, warehouseId: '1', unitId: '15' });
    await ctx.http().get('/v1/apiworking/discovery?idCaja=999').set(bearer(token)).expect(400);

    // Un cajero con permisos de venta pero sin «configurar» no lo ve.
    const cashier = await fx.userWithRole('CASHIER', { clinicId });
    const cashierToken = (await ctx.http().post('/v1/auth/login').send({ email: cashier.user.email, password: 'Clave-De-Prueba-123' }).expect(200)).body.accessToken as string;
    const sel = await ctx.http().post('/v1/auth/select-context').set(bearer(cashierToken)).send({ clinicId, branchId: null }).expect(200);
    await ctx.http().get('/v1/apiworking/discovery').set(bearer(sel.body.accessToken)).expect(403);
  });

  it('vista previa: JSON exacto con SHA-256, ids como en la guía y sin autorizar lo ajeno', async () => {
    const p = await ctx.http().post('/v1/apiworking/sales/preview').set(bearer(token)).send(draft()).expect(200);
    expect(p.body.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(p.body.totalCents).toBe(10_000);
    expect(p.body.suggestedDocument).toBe('BOLETA');
    expect(p.body.request).toMatchObject({ idCaja: '5', idCliente: 202600000038, idSerie: 11, aplicaIGV: '1', totalVenta: 0, fechaDoc: '2026-11-02', cadenaPago: '1^100.00^0~' });
    expect(p.body.request.detalle[0]).toMatchObject({ idProducto: 0, idAlmacen: 1, idUnidadMedida: '15', cantidad: 2, precioVenta: 50, nombreProducto: 'Profilaxis', itemPedido: '1' });
    // No hubo escritura: solo lecturas.
    expect(seen.some((s) => s.path === '/api/Facturacion/registro-documento')).toBe(false);

    await ctx.http().post('/v1/apiworking/sales/preview').set(bearer(token)).send(draft({ idSerie: '12' })).expect(400);
    await ctx.http().post('/v1/apiworking/sales/preview').set(bearer(token)).send(draft({ idCaja: '6' })).expect(400);
    await ctx.http().post('/v1/apiworking/sales/preview').set(bearer(token)).send(draft({ customerId: '999' })).expect(400);
  });

  async function approve(over: Record<string, unknown> = {}) {
    const d = draft(over);
    const p = await ctx.http().post('/v1/apiworking/sales/preview').set(bearer(token)).send(d).expect(200);
    return { ...d, approvedHash: p.body.hash as string, idempotencyKey: randomUUID() };
  }
  const registros = () => seen.filter((s) => s.path === '/api/Facturacion/registro-documento').length;

  it('registra una venta UNA sola vez: exige la aprobación exacta y es idempotente', async () => {
    const body = await approve();
    // Una venta distinta a la aprobada no se envía.
    const changed = await ctx.http().post('/v1/apiworking/sales').set(bearer(token)).send({ ...body, lines: [{ name: 'Otra cosa', quantity: 1, unitPriceCents: 100 }] });
    expect(changed.status).toBe(409);
    expect(changed.body.code).toBe('PREVIEW_CHANGED');
    expect(registros()).toBe(0);

    const before = registros();
    const created = await ctx.http().post('/v1/apiworking/sales').set(bearer(token)).send(body).expect(201);
    expect(created.body).toMatchObject({ docStatus: 'SENT', externalDocId: '201900000123', externalNumber: 'B001-00000123', paymentStatus: 'NO_EVIDENCE', totalCents: 10_000, serie: 'B001' });
    expect(registros()).toBe(before + 1);
    expect(seen.filter((s) => s.path === '/api/Facturacion/registro-documento').at(-1)!.auth).toBe(`Bearer ${EXTERNAL_TOKEN}`);

    // Reintentar con la misma clave devuelve la misma venta y NO vuelve a llamar a Apiworking.
    const replay = await ctx.http().post('/v1/apiworking/sales').set(bearer(token)).send(body).expect(201);
    expect(replay.body.id).toBe(created.body.id);
    expect(registros()).toBe(before + 1);
    // La misma clave con otro contenido es un error.
    const reuse = await ctx.http().post('/v1/apiworking/sales').set(bearer(token)).send({ ...body, approvedHash: 'a'.repeat(64) });
    expect(reuse.status).toBe(409);
    expect(reuse.body.code).toBe('IDEMPOTENCY_MISMATCH');
  });

  it('el cobro es un estado aparte: solo se confirma si controlPagos cubre el total', async () => {
    const sale = (await ctx.http().get('/v1/apiworking/sales').set(bearer(token)).expect(200)).body.items[0];
    scenario.pagos = 'none';
    let v = await ctx.http().post(`/v1/apiworking/sales/${sale.id}/verify`).set(bearer(token)).expect(200);
    expect(v.body.sale.paymentStatus).toBe('NO_EVIDENCE');
    expect(v.body.paymentMessage).toMatch(/pagos/);
    scenario.pagos = 'paid';
    v = await ctx.http().post(`/v1/apiworking/sales/${sale.id}/verify`).set(bearer(token)).expect(200);
    expect(v.body.paidCents).toBe(100_000);
    expect(v.body.sale.paymentStatus).toBe('CONFIRMED_REMOTE');
  });

  it('un rechazo del proveedor queda RECHAZADO y un fallo 5xx queda como resultado desconocido, sin reintentos', async () => {
    scenario.registro = 'reject';
    const rejectBody = await approve({ description: 'Rechazo' });
    const rejected = await ctx.http().post('/v1/apiworking/sales').set(bearer(token)).send(rejectBody).expect(201);
    expect(rejected.body).toMatchObject({ docStatus: 'REJECTED', failureReason: 'Serie sin correlativo' });

    scenario.registro = 'boom';
    const before = registros();
    const boomBody = await approve({ description: 'Fallo' });
    const unknown = await ctx.http().post('/v1/apiworking/sales').set(bearer(token)).send(boomBody).expect(201);
    expect(unknown.body.docStatus).toBe('PENDING_RECONCILIATION');
    expect(registros()).toBe(before + 1); // una sola llamada: nada de reintentos en escrituras
    expect(unknown.body.actions).toMatchObject({ reconcile: true, void: false });

    // Candidatos para conciliar: mismo total y fecha, y que no estén ya vinculados a otra venta.
    const v = await ctx.http().post(`/v1/apiworking/sales/${unknown.body.id}/verify`).set(bearer(token)).expect(200);
    expect(v.body.candidates).toEqual([]); // B001-00000123 ya pertenece a la primera venta

    await ctx.http().post(`/v1/apiworking/sales/${unknown.body.id}/reconcile`).set(bearer(token)).send({ outcome: 'REGISTERED', note: 'Verificado a mano' }).expect(422);
    const rec = await ctx.http().post(`/v1/apiworking/sales/${unknown.body.id}/reconcile`).set(bearer(token)).send({ outcome: 'NOT_REGISTERED', note: 'No aparece en Apiworking' }).expect(200);
    expect(rec.body.docStatus).toBe('REJECTED');
    await ctx.http().post(`/v1/apiworking/sales/${unknown.body.id}/reconcile`).set(bearer(token)).send({ outcome: 'NOT_REGISTERED', note: 'otra vez' }).expect(409);
  });

  it('una respuesta 200 incompleta no se da por buena: queda por conciliar', async () => {
    scenario.registro = 'incomplete';
    const incBody = await approve({ description: 'Incompleta' });
    const r = await ctx.http().post('/v1/apiworking/sales').set(bearer(token)).send(incBody).expect(201);
    expect(r.body.docStatus).toBe('PENDING_RECONCILIATION');
    scenario.registro = 'ok';
  });

  it('respeta el tope de envíos reales en 24 horas', async () => {
    // Ya hubo 4 envíos reales (ok, rechazo, fallo, incompleta) y el tope es 4.
    const fifth = await approve({ description: 'Quinta' });
    const blocked = await ctx.http().post('/v1/apiworking/sales').set(bearer(token)).send(fifth);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('REAL_OPERATIONS_LIMIT');
  });

  it('la anulación pasa a «en curso» y se confirma al verificar; el JWT externo se pierde al cerrar sesión', async () => {
    await ctx.db.apiworkingSale.updateMany({ data: { attemptedAt: new Date(Date.now() - 48 * 3_600_000) } }); // fuera de la ventana de 24 h
    const sale = (await ctx.db.apiworkingSale.findFirstOrThrow({ where: { docStatus: 'SENT' } }));
    const voided = await ctx.http().post(`/v1/apiworking/sales/${sale.id}/void`).set(bearer(token)).send({ reason: 'Error de digitación' }).expect(200);
    expect(voided.body.voidStatus).toBe('IN_PROGRESS');
    const call = seen.filter((s) => s.path === '/api/Facturacion/anular').at(-1)!;
    expect(call.query.get('idDocumentoPago')).toBe('201900000123');
    expect(call.query.get('usuario')).toBe('gina');
    expect(call.query.get('motivoAnulacion')).toBe('Error de digitación');
    const v = await ctx.http().post(`/v1/apiworking/sales/${sale.id}/void`).set(bearer(token)).send({ reason: 'Otra vez' });
    expect(v.status).toBe(409);

    const check = await ctx.http().post(`/v1/apiworking/sales/${sale.id}/verify`).set(bearer(token)).expect(200);
    expect(check.body.sale.voidStatus).toBe('VOIDED');

    // Sin el JWT externo en memoria (reinicio de la API, cierre de sesión) hay que volver a entrar.
    ctx.app.get(ApiworkingSessionStore).deleteForUser(userId);
    const gone = await ctx.http().get('/v1/apiworking/clients').set(bearer(token));
    expect(gone.status).toBe(409);
    expect(gone.body.code).toBe('APIWORKING_SESSION_REQUIRED');
  });

  it('con la escritura APAGADA se puede preparar y revisar, pero jamás sale un envío a registro-documento', async () => {
    const before = process.env['APIWORKING_AUTHZ_WRITE'];
    process.env['APIWORKING_AUTHZ_WRITE'] = 'false';
    const ro = await createTestContext();
    try {
      const api = (t: string) => ({ get: (p: string) => ro.http().get(`/v1${p}`).set(bearer(t)), post: (p: string, b: object) => ro.http().post(`/v1${p}`).set(bearer(t)).send(b) });
      const login = await ro.http().post('/v1/auth/apiworking-login').send({ usuario: 'gina', password: 'clave-correcta' }).expect(200);
      const sel = await ro.http().post('/v1/auth/select-context').set(bearer(login.body.accessToken)).send({ clinicId, branchId: null }).expect(200);
      const a = api(sel.body.accessToken);
      const st = await a.get('/apiworking/status').expect(200);
      expect(st.body).toMatchObject({ read: true, write: false });
      const d = draft();
      const p = await a.post('/apiworking/sales/preview', d).expect(200);
      expect(p.body).toMatchObject({ mode: 'READ_ONLY', writeEnabled: false });
      const sent = registros();
      const res = await a.post('/apiworking/sales', { ...d, approvedHash: p.body.hash, idempotencyKey: randomUUID() });
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('WRITE_DISABLED');
      const sale = await ctx.db.apiworkingSale.findFirstOrThrow({ where: { docStatus: 'SENT' } });
      await a.post(`/apiworking/sales/${sale.id}/void`, { reason: 'No debe salir' }).expect(503);
      expect(registros()).toBe(sent);
      expect(seen.filter((s) => s.path === '/api/Facturacion/anular').length).toBe(1); // solo la anulación del test anterior
    } finally {
      await ro.close();
      if (before === undefined) delete process.env['APIWORKING_AUTHZ_WRITE'];
      else process.env['APIWORKING_AUTHZ_WRITE'] = before;
    }
  });

  it('abre la caja con vista previa, aprobación exacta, una sola vez y con tope', async () => {
    const login = await enter();
    const sel = await ctx.http().post('/v1/auth/select-context').set(bearer(login.accessToken)).send({ clinicId, branchId: null }).expect(200);
    const t = sel.body.accessToken as string;
    const aperturas = () => seen.filter((x) => x.method === 'POST' && x.path.startsWith('/api/CajaChica/AperturaCajaChica')).length;
    scenario.cajaOpen = false;

    const st = await ctx.http().get('/v1/apiworking/cash').set(bearer(t)).expect(200);
    expect(st.body.cajas).toEqual([{ id: '5', name: 'Caja Glow', branch: 'Principal', opened: false }]);
    expect(st.body.turnos).toEqual([{ id: '1', name: 'Mañana' }, { id: '2', name: 'Tarde' }]);

    const draftCash = { idCaja: '5', openingCents: 10_000 };
    const p = await ctx.http().post('/v1/apiworking/cash/preview').set(bearer(t)).send(draftCash).expect(200);
    expect(p.body).toMatchObject({ openingText: 'S/ 100.00', alreadyOpen: false, turn: '1' });
    expect(aperturas()).toBe(0);
    await ctx.http().post('/v1/apiworking/cash/preview').set(bearer(t)).send({ ...draftCash, idCaja: '6' }).expect(400);

    const stale = await ctx.http().post('/v1/apiworking/cash/open').set(bearer(t)).send({ ...draftCash, openingCents: 20_000, approvedHash: p.body.hash });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('PREVIEW_CHANGED');
    expect(aperturas()).toBe(0);

    const opened = await ctx.http().post('/v1/apiworking/cash/open').set(bearer(t)).send({ ...draftCash, approvedHash: p.body.hash }).expect(200);
    expect(opened.body).toMatchObject({ status: 'OPENED', movementId: '9001' });
    const sent = seen.filter((x) => x.method === 'POST' && x.path.startsWith('/api/CajaChica/AperturaCajaChica')).at(-1)!;
    expect(sent.auth).toBe(`Bearer ${EXTERNAL_TOKEN}`);
    expect(sent.body).toEqual({ idPersona: '201900000001', idUsuario: '77', idTurno: '1', idCaja: '5', cadenaDetalle: '1^100' });

    // Con la caja ya abierta no se envía nada.
    const again = await ctx.http().post('/v1/apiworking/cash/open').set(bearer(t)).send({ ...draftCash, approvedHash: p.body.hash });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ALREADY_OPEN');
    expect(aperturas()).toBe(1);

    // Fallo del servidor: resultado desconocido, sin reintento.
    scenario.cajaOpen = false;
    scenario.apertura = 'boom';
    const p2 = await ctx.http().post('/v1/apiworking/cash/preview').set(bearer(t)).send(draftCash).expect(200);
    const unknown = await ctx.http().post('/v1/apiworking/cash/open').set(bearer(t)).send({ ...draftCash, approvedHash: p2.body.hash }).expect(200);
    expect(unknown.body.status).toBe('UNKNOWN');
    expect(aperturas()).toBe(2);
    scenario.apertura = 'ok';

    // Dos intentos ya contados: con tope 4, tras dos más se bloquea.
    await ctx.db.auditLog.createMany({ data: [1, 2].map(() => ({ action: 'APIWORKING_CASH_OPEN_ATTEMPT', entity: 'ApiworkingCash', clinicId })) });
    const blocked = await ctx.http().post('/v1/apiworking/cash/open').set(bearer(t)).send({ ...draftCash, approvedHash: p2.body.hash });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('REAL_OPERATIONS_LIMIT');
    expect(aperturas()).toBe(2);
    scenario.cajaOpen = true;

    // Quien no tiene el permiso de abrir caja no puede ni previsualizar.
    const reception = await fx.userWithRole('RECEPTIONIST', { clinicId });
    const rt = (await ctx.http().post('/v1/auth/login').send({ email: reception.user.email, password: 'Clave-De-Prueba-123' }).expect(200)).body.accessToken as string;
    const rsel = await ctx.http().post('/v1/auth/select-context').set(bearer(rt)).send({ clinicId, branchId: null }).expect(200);
    await ctx.http().post('/v1/apiworking/cash/preview').set(bearer(rsel.body.accessToken)).send(draftCash).expect(403);
  });

  it('la auditoría registra la operación sin tokens, contraseñas ni cuerpos', async () => {
    const rows = await ctx.db.auditLog.findMany({ where: { action: { startsWith: 'APIWORKING_' } } });
    expect(rows.length).toBeGreaterThan(3);
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(EXTERNAL_TOKEN);
    expect(dump).not.toContain('clave-correcta');
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(['APIWORKING_IDENTITY_LINKED', 'APIWORKING_SALE_SENT', 'APIWORKING_SALE_REJECTED', 'APIWORKING_SALE_UNKNOWN_RESULT', 'APIWORKING_LOGIN_FAILED']));
  });
});
