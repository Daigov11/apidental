import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { AppConfig } from '../src/config/app-config.js';
import { ApiworkingClientsService } from '../src/apiworking/apiworking-clients.service.js';
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
  const scenario = { facturacion: null as null | Record<string, unknown>[], registro: 'ok' as 'ok' | 'list' | 'reject' | 'boom' | 'incomplete', pagos: 'none' as 'none' | 'paid', tenant: TENANT, cajaOpen: true, apertura: 'ok' as 'ok' | 'boom' | 'reject', clientes: 'ok' as 'ok' | 'boom', registrarPago: 'ok' as 'ok' | 'reject' | 'boom' };

  const customers = [
    { total: 3, id_cliente: 202600000038, id_persona: 202600000049, nombrecompleto: 'ROBERTO CARLOS ESPINAR VICHARRA', email: '', tipoDoc: 'D.N.I.', numerodocumento: '74908568', telefono: '', tipo_persona: 'N', estado: 'A', limite_credito: '0.00', saldo: 0, whatsapp: '', saldo_restante: '0.00' },
    { total: 3, id_cliente: 202600000040, id_persona: 202600000051, nombrecompleto: 'CLINICA SONRISA SAC', email: 'a@b.pe', tipoDoc: 'R.U.C.', numerodocumento: '20123456789', telefono: '999', tipo_persona: 'J', estado: 'A', limite_credito: '0.00', saldo: 0, whatsapp: '', saldo_restante: '0.00' },
    { total: 3, id_cliente: 202600000041, id_persona: 202600000052, nombrecompleto: 'CLIENTE INACTIVO', email: '', tipoDoc: 'D.N.I.', numerodocumento: '11111111', telefono: '', tipo_persona: 'N', estado: 'I', limite_credito: '0.00', saldo: 0, whatsapp: '', saldo_restante: '0.00' },
  ];

  const ok = (data: unknown) => ({ codResponse: 1, message: 'OK', data });

  function route(req: Seen): { status: number; body?: unknown; hang?: boolean } {
    if (req.method === 'POST' && req.path === '/api/Cliente/ClienteDoc') {
      if (req.query.get('tipoDoc') === '6') return { status: 200, body: { codResponse: 0, message: 'No se encontró el RUC' } };
      customers.push({ total: 4, id_cliente: 202600000099, id_persona: 202600000100, nombrecompleto: 'PACIENTE NUEVO', email: '', tipoDoc: 'D.N.I.', numerodocumento: req.query.get('nroDoc') ?? '', telefono: '', tipo_persona: 'N', estado: 'A', limite_credito: '0.00', saldo: 0, whatsapp: '', saldo_restante: '0.00' });
      if (req.query.get('nroDoc') === '70000001') return { status: 200, body: ok({ result: 1, id: 202600000098, nombre: 'JUAN CARLOS', nombrecompleto: 'JUAN CARLOS PEREZ GOMEZ', error: null }) };
      return { status: 200, body: ok({ id: 202600000099 }) };
    }
    if (req.method === 'POST' && req.path === `/api/CajaChica/PostCierreCajaChica/${TENANT}`) {
      scenario.cajaOpen = false;
      return { status: 200, body: ok([{ result: 1, duplicado: 0, msjDocumentos: '', msjCuadroPerfecto: '', idAuditoria: '1' }]) };
    }
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
      case 'GET /api/CajaChica/consulta-aperturada': return { status: 200, body: scenario.cajaOpen ? ok({ id_movimiento_caja: 9001 }) : { codResponse: 0, message: 'No se encontraron datos registrados' } };
      case 'GET /api/CajaChica/turnos': return { status: 200, body: ok([{ idTurno: 1, turno: 'Mañana' }, { idTurno: 2, turno: 'Tarde' }]) };
      case 'GET /api/Caja/tipo-documentos': return { status: 200, body: ok([{ id_tipo_documento: 2, tipo_documento: 'Boleta' }, { id_tipo_documento: 9, tipo_documento: 'No autorizado' }]) };
      case 'GET /api/Facturacion/series': return { status: 200, body: ok([{ id_serie: 11, serie: 'B001' }, { id_serie: 12, serie: 'B002' }]) };
      case 'GET /api/CajaChica/formas-pago': return { status: 200, body: ok([{ id_metodo_pago: 1, metodoPago: 'Efectivo' }]) };
      case 'GET /api/Cliente/clientes': return scenario.clientes === 'boom' ? { status: 500, body: { error: 'x' } } : { status: 200, body: ok(customers) };
      case 'POST /api/Facturacion/registro-documento':
        if (scenario.registro === 'boom') return { status: 500, body: { error: 'x' } };
        if (scenario.registro === 'reject') return { status: 200, body: { codResponse: 0, message: 'Serie sin correlativo' } };
        if (scenario.registro === 'incomplete') return { status: 200, body: ok({ result: 0, error: 'algo' }) };
        // Forma real (guía, aqua 31-10-2026): data es una LISTA de un elemento y el número llega sin serie.
        if (scenario.registro === 'list') return { status: 200, body: ok([{ result: 1, duplicado: 0, idComprobante: 22600001578, idSerie: 11, numero: '1423', numeroactual: 1424, error: null }]) };
        return { status: 200, body: ok({ result: 1, error: null, idComprobante: 201900000123, nroComprobante: 'B001-00000123' }) };
      case 'GET /api/Facturacion/controlPagos':
        return scenario.pagos === 'paid' ? { status: 200, body: ok([{ metodopago: 'Efectivo', importe: '1,000.00', estado: 'P' }]) } : { status: 200, body: { codResponse: 0, message: 'No se pudo encontrar pagos' } };
      case 'GET /api/Facturacion': return { status: 200, body: scenario.facturacion ? ok(scenario.facturacion) : ok([{ nroComprobante: 'B001-00000123', estado: scenario.registro === 'ok' ? 'ANULADO' : 'EMITIDO', totalVenta: '100.00', monto_saldo: '100.00', metodospagos: '' }]) };
      case 'POST /api/Facturacion/registrar-pago':
        if (scenario.registrarPago === 'boom') return { status: 500, body: { error: 'x' } };
        if (scenario.registrarPago === 'reject') return { status: 200, body: { codResponse: 0, message: 'El documento ya está pagado' } };
        return { status: 200, body: ok({ result: 1, idComprobante: 201900000123, error: null, duplicado: null }) };
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
    const p = await ctx.http().post('/v1/apiworking/sales/preview').set(bearer(token)).send(d);
    if (p.status !== 200) throw new Error(`preview ${p.status} ${JSON.stringify(p.body)}`);
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
    // El pago se aplica en el mismo paso (registrar-pago), sin otra acción de la persona.
    expect(created.body).toMatchObject({ docStatus: 'SENT', externalDocId: '201900000123', externalNumber: 'B001-00000123', paymentStatus: 'CONFIRMED_REMOTE', totalCents: 10_000, serie: 'B001' });
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
    await ctx.db.apiworkingSale.update({ where: { id: sale.id }, data: { paymentStatus: 'NO_EVIDENCE' } });
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

  it('crea un cliente por documento (ClienteDoc): vista previa, aprobación, un envío y sin guardar el DNI', async () => {
    await ctx.db.apiworkingSale.updateMany({ data: { attemptedAt: new Date(Date.now() - 48 * 3_600_000) } }); // fuera de la ventana de 24 h del tope
    const login = await enter();
    const sel = await ctx.http().post('/v1/auth/select-context').set(bearer(login.accessToken)).send({ clinicId, branchId: null }).expect(200);
    const t = sel.body.accessToken as string;
    const altas = () => seen.filter((x) => x.method === 'POST' && x.path === '/api/Cliente/ClienteDoc').length;
    const draftC = { docType: '1', docNumber: '12345678' };

    await ctx.http().post('/v1/apiworking/clients/preview').set(bearer(t)).send({ docType: '1', docNumber: '123' }).expect(400);
    const p = await ctx.http().post('/v1/apiworking/clients/preview').set(bearer(t)).send(draftC).expect(200);
    expect(p.body).toMatchObject({ docTypeLabel: 'DNI', docNumber: '12345678', exists: null });
    expect(altas()).toBe(0);

    const stale = await ctx.http().post('/v1/apiworking/clients').set(bearer(t)).send({ ...draftC, docNumber: '87654321', approvedHash: p.body.hash });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('PREVIEW_CHANGED');
    expect(altas()).toBe(0);

    const created = await ctx.http().post('/v1/apiworking/clients').set(bearer(t)).send({ ...draftC, name: 'Paciente Local', approvedHash: p.body.hash }).expect(200);
    expect(created.body).toMatchObject({ status: 'CREATED', id: '202600000099' });
    expect(created.body.customer).toMatchObject({ name: 'Paciente Local', docNumber: '12345678' });
    expect(await ctx.db.apiworkingCustomer.count({ where: { externalCustomerId: '202600000099' } })).toBe(1);
    const call = seen.filter((x) => x.path === '/api/Cliente/ClienteDoc').at(-1)!;
    expect(call.query.get('tipoDoc')).toBe('1');
    expect(call.query.get('nroDoc')).toBe('12345678');
    expect(call.body).toBeNull();
    expect(altas()).toBe(1);

    // Ya existe: no se vuelve a enviar.
    const again = await ctx.http().post('/v1/apiworking/clients/preview').set(bearer(t)).send(draftC).expect(200);
    expect(again.body.exists).toMatchObject({ id: '202600000099' });
    const dup = await ctx.http().post('/v1/apiworking/clients').set(bearer(t)).send({ ...draftC, approvedHash: again.body.hash });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('ALREADY_EXISTS');
    expect(altas()).toBe(1);

    // Si Apiworking no responde (o no lo lista), el cliente se encuentra en el espejo local.
    scenario.clientes = 'boom';
    (ctx.app.get(ApiworkingClientsService) as unknown as { cache: unknown }).cache = null; // sin el caché de 60 s
    const offline = await ctx.http().get('/v1/apiworking/clients?search=12345678').set(bearer(t)).expect(200);
    expect(offline.body.offline).toBe(true);
    expect(offline.body.items.map((c: { name: string }) => c.name)).toEqual(['Paciente Local']);
    scenario.clientes = 'ok';
    (ctx.app.get(ApiworkingClientsService) as unknown as { cache: unknown }).cache = null;
    const online = await ctx.http().get('/v1/apiworking/clients?search=paciente').set(bearer(t)).expect(200);
    expect(online.body.offline).toBe(false);
    expect(online.body.items).toHaveLength(1); // el mismo id no se duplica entre Apiworking y el espejo

    // El número de documento no queda en la auditoría.
    const audit = JSON.stringify(await ctx.db.auditLog.findMany({ where: { action: { startsWith: 'APIWORKING_CUSTOMER' } } }));
    expect(audit).toContain('APIWORKING_CUSTOMER_CREATED');
    expect(audit).not.toContain('12345678');
  });

  it('cierra la caja con las cadenas vacías y solo si está abierta', async () => {
    const login = await enter();
    const sel = await ctx.http().post('/v1/auth/select-context').set(bearer(login.accessToken)).send({ clinicId, branchId: null }).expect(200);
    const t = sel.body.accessToken as string;
    const cierres = () => seen.filter((x) => x.method === 'POST' && x.path.startsWith('/api/CajaChica/PostCierreCajaChica')).length;

    scenario.cajaOpen = false;
    const closedPrev = await ctx.http().post('/v1/apiworking/cash/close-preview').set(bearer(t)).send({ idCaja: '5' }).expect(200);
    expect(closedPrev.body.isOpen).toBe(false);
    const notOpen = await ctx.http().post('/v1/apiworking/cash/close').set(bearer(t)).send({ idCaja: '5', approvedHash: closedPrev.body.hash });
    expect(notOpen.status).toBe(409);
    expect(notOpen.body.code).toBe('NOT_OPEN');
    expect(cierres()).toBe(0);

    scenario.cajaOpen = true;
    const p = await ctx.http().post('/v1/apiworking/cash/close-preview').set(bearer(t)).send({ idCaja: '5' }).expect(200);
    expect(p.body.isOpen).toBe(true);
    const done = await ctx.http().post('/v1/apiworking/cash/close').set(bearer(t)).send({ idCaja: '5', approvedHash: p.body.hash });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('CLOSED');
    expect(cierres()).toBe(1);
    expect(seen.filter((x) => x.path.startsWith('/api/CajaChica/PostCierreCajaChica')).at(-1)!.body).toEqual({
      idPersona: '201900000001', idTurno: '1', idCaja: '5', cadenaDetalle: '', cadenaCierre: '', cadenaCierreDetalle: '', idCajaSel: '', ip: '', usuario: '77',
    });
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

    // Cuatro intentos ya contados (cliente, cierre, reapertura y fallo): con tope 4 se bloquea.
    await ctx.db.auditLog.createMany({ data: [1].map(() => ({ action: 'APIWORKING_CASH_OPEN_ATTEMPT', entity: 'ApiworkingCash', clinicId })) });
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

  it('contingencia: cobra en la caja LOCAL sin llamar a Apiworking, el cliente se recuerda y el documento se emite después con aprobación', async () => {
    const appCfg = ctx.app.get(AppConfig).apiworking as { maxRealOperations: number };
    const savedCap = appCfg.maxRealOperations;
    appCfg.maxRealOperations = 50; // el tope ya lo agotaron las pruebas anteriores
    try {
      await ctx.db.apiworkingSale.updateMany({ data: { attemptedAt: new Date(Date.now() - 48 * 3_600_000) } });
      const branch = (await ctx.db.branch.findFirst({ where: { clinicId } })) ?? (await fx.branch(clinicId));
      const login = await enter();
      const sel = await ctx.http().post('/v1/auth/select-context').set(bearer(login.accessToken)).send({ clinicId, branchId: branch.id }).expect(200);
      const t = sel.body.accessToken as string;
      const cfg = (await ctx.http().get('/v1/cashbox/config').set(bearer(t)).expect(200)).body as { accounts: { id: string; name: string }[]; categories: { id: string; flow: string }[] };
      const accountId = cfg.accounts.find((a) => a.name === 'Efectivo')!.id;
      const categoryId = cfg.categories.find((c) => c.flow === 'INCOME')!.id;
      const registros = () => seen.filter((x) => x.path === '/api/Facturacion/registro-documento').length;
      scenario.cajaOpen = true;
      scenario.registro = 'ok';

      // Mientras Apiworking responde, usar al cliente en una vista previa lo deja en el espejo local.
      await ctx.http().post('/v1/apiworking/sales/preview').set(bearer(t)).send(draft()).expect(200);
      expect(await ctx.db.apiworkingCustomer.count({ where: { externalCustomerId: '202600000038' } })).toBe(1);

      const body = { customerId: '202600000038', description: 'Limpieza dental', lines: [{ name: 'Profilaxis', quantity: 2, unitPriceCents: 5000 }], accountId, categoryId, requestKey: randomUUID() };
      // Con la caja local cerrada no se registra nada.
      const closed = await ctx.http().post('/v1/apiworking/contingency').set(bearer(t)).send(body);
      expect(closed.status).toBe(409);
      expect(await ctx.db.apiworkingSale.count({ where: { contingency: true } })).toBe(0);

      await ctx.http().post('/v1/cashbox/open').set(bearer(t)).send({ openings: [{ accountId, amountCents: 0 }] }).expect(201);
      const before = registros();
      const rec = await ctx.http().post('/v1/apiworking/contingency').set(bearer(t)).send(body).expect(201);
      expect(rec.body).toMatchObject({ docStatus: 'PENDING_ISSUE', contingency: true, totalCents: 10_000 });
      expect(rec.body.actions).toMatchObject({ issue: true, void: false, verify: false });
      expect(registros()).toBe(before); // jamás se llamó a Apiworking

      // Reenviar la misma clave no duplica ni la venta ni el movimiento de caja.
      const again = await ctx.http().post('/v1/apiworking/contingency').set(bearer(t)).send(body).expect(201);
      expect(again.body.id).toBe(rec.body.id);
      expect(await ctx.db.apiworkingSale.count({ where: { contingency: true } })).toBe(1);
      const movements = await ctx.http().get('/v1/cashbox/movements').set(bearer(t)).expect(200);
      expect(JSON.stringify(movements.body)).toContain('Cobro en contingencia: Limpieza dental');

      // Un cliente que no está en el espejo no se puede cobrar en contingencia.
      await ctx.http().post('/v1/apiworking/contingency').set(bearer(t)).send({ ...body, customerId: '202600000041', requestKey: randomUUID() }).expect(400);

      // Emisión posterior: no se puede cambiar el monto cobrado…
      const pendingId = rec.body.id as string;
      const dChanged = draft({ pendingSaleId: pendingId, lines: [{ name: 'Profilaxis', quantity: 2, unitPriceCents: 6000 }] });
      const pChanged = await ctx.http().post('/v1/apiworking/sales/preview').set(bearer(t)).send(dChanged).expect(200);
      const changed = { ...dChanged, approvedHash: pChanged.body.hash as string, idempotencyKey: randomUUID() };
      const bad = await ctx.http().post('/v1/apiworking/sales').set(bearer(t)).send(changed);
      expect(bad.status).toBe(409);
      expect(bad.body.code).toBe('PENDING_CHANGED');
      expect(registros()).toBe(before);

      // …y con lo mismo se emite a mano, completando ESA fila (no crea otra).
      const same = await ctx.http().post('/v1/apiworking/sales/preview').set(bearer(t)).send({ ...draft(), pendingSaleId: pendingId }).expect(200);
      const issued = await ctx.http().post('/v1/apiworking/sales').set(bearer(t)).send({ ...draft(), pendingSaleId: pendingId, approvedHash: same.body.hash, idempotencyKey: randomUUID() }).expect(201);
      expect(issued.body).toMatchObject({ id: pendingId, docStatus: 'SENT', externalNumber: 'B001-00000123', contingency: true });
      expect(registros()).toBe(before + 1);
      expect(await ctx.db.apiworkingSale.count({ where: { contingency: true } })).toBe(1);
      // Ya emitida: no se vuelve a emitir.
      const dup = await ctx.http().post('/v1/apiworking/sales/preview').set(bearer(t)).send({ ...draft(), pendingSaleId: pendingId });
      expect(dup.status).toBe(200); // la vista previa no envía nada
      const reissue = await ctx.http().post('/v1/apiworking/sales').set(bearer(t)).send({ ...draft(), pendingSaleId: pendingId, approvedHash: dup.body.hash, idempotencyKey: randomUUID() });
      expect(reissue.status).toBe(409);
      expect(reissue.body.code).toBe('NOT_PENDING_ISSUE');
    } finally {
      appCfg.maxRealOperations = savedCap;
    }
  });

  it('el borrador de cobro toma al paciente por su documento y el espejo de clientes', async () => {
    const author = (await ctx.db.user.findFirstOrThrow()).id;
    const patient = await ctx.db.patient.create({ data: { clinicId, firstName: 'Diego', lastName: 'Mendieta', secondLastName: 'Huaroto', createdById: author } });
    await ctx.db.patientIdentifier.create({ data: { clinicId, patientId: patient.id, type: 'DNI', number: '74908568', activeKey: `${clinicId}|DNI|74908568`, patientTypeKey: `${patient.id}|DNI`, createdById: author } });
    const login = await enter();
    const sel = await ctx.http().post('/v1/auth/select-context').set(bearer(login.accessToken)).send({ clinicId, branchId: null }).expect(200);
    const d = await ctx.http().get(`/v1/apiworking/billing-draft?patientId=${patient.id}`).set(bearer(sel.body.accessToken)).expect(200);
    expect(d.body.patient).toEqual({ id: patient.id, name: 'Diego Mendieta Huaroto' });
    expect(d.body.identifier).toEqual({ docType: '1', docTypeLabel: 'DNI', docNumber: '74908568' });
    expect(d.body.customer).toMatchObject({ id: '202600000038', docNumber: '74908568' });
    expect(d.body).toMatchObject({ appointment: null, description: null, canBill: true });
    await ctx.http().get('/v1/apiworking/billing-draft').set(bearer(sel.body.accessToken)).expect(400);
  });

  it('una cuenta de Apiworking confirma su identidad (reautenticación) con la contraseña de Apiworking', async () => {
    const login = await enter();
    const sel = await ctx.http().post('/v1/auth/select-context').set(bearer(login.accessToken)).send({ clinicId, branchId: null }).expect(200);
    const t = sel.body.accessToken as string;
    const body = (password: string) => ({ password, purpose: 'CLOSE_CLINICAL_NOTE', targetId: randomUUID() });
    const ok = await ctx.http().post('/v1/auth/reauthenticate').set(bearer(t)).send(body('clave-correcta')).expect(200);
    expect(ok.body).toMatchObject({ singleUse: true, isSignature: false });
    expect(JSON.stringify(await ctx.db.auditLog.findMany({ where: { action: { startsWith: 'REAUTH' } } }))).not.toContain('clave-correcta');
    await ctx.http().post('/v1/auth/reauthenticate').set(bearer(t)).send(body('clave-incorrecta')).expect(401);
    // La contraseña local aleatoria de la cuenta no sirve: solo vale la de Apiworking.
    scenario.tenant = 'prod_ti_otro_cliente';
    await ctx.http().post('/v1/auth/reauthenticate').set(bearer(t)).send(body('clave-correcta')).expect(401);
    scenario.tenant = TENANT;
  });

  it('el pago se aplica solo tras registrar; si falla, el documento queda registrado y el pago manual no se reintenta a ciegas', async () => {
    const appCfg = ctx.app.get(AppConfig).apiworking as { maxRealOperations: number };
    const savedCap = appCfg.maxRealOperations;
    appCfg.maxRealOperations = 500; // el tope ya lo agotaron las pruebas anteriores
    scenario.cajaOpen = true;
    const login = await enter(); // la prueba anterior borró la sesión externa
    token = ((await ctx.http().post('/v1/auth/select-context').set(bearer(login.accessToken)).send({ clinicId, branchId: null }).expect(200)).body.accessToken as string);
    try {
      const base = seen.filter((x) => x.path === '/api/Facturacion/registrar-pago').length;
      const attemptsBefore = await ctx.db.auditLog.count({ where: { action: 'APIWORKING_PAYMENT_ATTEMPT' } });
      const pagos = () => seen.filter((x) => x.path === '/api/Facturacion/registrar-pago').slice(base);
      const direct = (over: Record<string, unknown> = {}) => ({ ...draft(over), idempotencyKey: randomUUID() });

      // Pago rechazado al vender: la venta queda registrada, con el pago pendiente y el motivo.
      scenario.registrarPago = 'reject';
      const created = await ctx.http().post('/v1/apiworking/sales').set(bearer(token)).send(direct({ description: 'Para pagar' })).expect(201);
      expect(created.body).toMatchObject({ docStatus: 'SENT', paymentStatus: 'NO_EVIDENCE' });
      expect(created.body.failureReason).toMatch(/Pago no aplicado en Apiworking: El documento ya está pagado/);
      expect(pagos().length).toBe(1);

      // Resultado dudoso en el reintento manual: no se reintenta solo ni se da por aplicado.
      scenario.registrarPago = 'boom';
      const unk = await ctx.http().post(`/v1/apiworking/sales/${created.body.id}/pay`).set(bearer(token)).expect(409);
      expect(unk.body.code).toBe('PAYMENT_UNCONFIRMED');
      const again = await ctx.http().post(`/v1/apiworking/sales/${created.body.id}/pay`).set(bearer(token)).expect(409);
      expect(again.body.code).toBe('PAYMENT_ALREADY_SENT');
      expect(pagos().length).toBe(2);

      // Venta directa (sin vista previa ni aprobación) con la respuesta REAL de Apiworking (data en lista): registrada y pagada.
      scenario.registrarPago = 'ok';
      scenario.registro = 'list';
      const second = await ctx.http().post('/v1/apiworking/sales').set(bearer(token)).send(direct({ description: 'Segunda' })).expect(201);
      expect(second.body).toMatchObject({ docStatus: 'SENT', externalDocId: '22600001578', externalNumber: 'B001-1423', paymentStatus: 'CONFIRMED_REMOTE', failureReason: null });
      expect(second.body.actions.pay).toBe(false);
      const call = pagos().at(-1)!;
      expect(call.auth).toBe(`Bearer ${EXTERNAL_TOKEN}`);
      expect(call.body).toEqual({ idDocumentoPago: 22600001578, cadenaPago: [{ idMetodoPago: '1', importePago: 100 }], vuelto: 0 });
      // La caja es la de la sesión: el cuerpo lleva la primera caja que informa GET /api/Caja.
      expect(seen.filter((x) => x.path === '/api/Facturacion/registro-documento').at(-1)!.body).toMatchObject({ idCaja: '5' });
      await ctx.http().post(`/v1/apiworking/sales/${second.body.id}/pay`).set(bearer(token)).expect(409);
      expect(pagos().length).toBe(3);

      // Cada intento queda auditado antes del envío; el pago no cuenta aparte en el tope (es parte de la venta).
      expect(await ctx.db.auditLog.count({ where: { action: 'APIWORKING_PAYMENT_ATTEMPT' } })).toBe(attemptsBefore + 3);
      const third = await ctx.db.apiworkingSale.findFirstOrThrow({ where: { id: created.body.id } });
      expect(third.paymentStatus).toBe('NO_EVIDENCE');
    } finally {
      appCfg.maxRealOperations = savedCap;
      scenario.registro = 'ok';
    }
  });

  it('un resultado dudoso se resuelve solo: busca el comprobante en Apiworking, lo da por registrado y aplica el pago', async () => {
    const appCfg = ctx.app.get(AppConfig).apiworking as { maxRealOperations: number };
    const savedCap = appCfg.maxRealOperations;
    appCfg.maxRealOperations = 500;
    try {
      const registrosAntes = seen.filter((x) => x.path === '/api/Facturacion/registro-documento').length;
      scenario.registro = 'boom';
      scenario.pagos = 'none';
      scenario.facturacion = [
        { nroComprobante: 'B001-00000999', id_documento_pago: '22600009999', estado: 'E', totalVenta: '77.00', monto_saldo: 77 },
        { nroComprobante: 'F001-00000001', id_documento_pago: '22600000001', estado: 'E', totalVenta: '77.00', monto_saldo: 77 },
      ];
      const r = await ctx.http().post('/v1/apiworking/sales').set(bearer(token)).send({ ...draft({ description: 'Dudosa', lines: [{ name: 'Control', quantity: 1, unitPriceCents: 7700 }] }), idempotencyKey: randomUUID() }).expect(201);
      expect(r.body).toMatchObject({ docStatus: 'SENT', externalNumber: 'B001-00000999', externalDocId: '22600009999', paymentStatus: 'CONFIRMED_REMOTE', failureReason: null });
      // El documento se envió UNA sola vez: lo encontrado se usa, nunca se reenvía.
      expect(seen.filter((x) => x.path === '/api/Facturacion/registro-documento').length).toBe(registrosAntes + 1);
      expect(seen.filter((x) => x.path === '/api/Facturacion/registrar-pago').at(-1)!.body).toMatchObject({ idDocumentoPago: 22600009999 });

      // Sin una coincidencia única queda «número por confirmar», sin mensajes de conciliación.
      scenario.facturacion = [];
      const u = await ctx.http().post('/v1/apiworking/sales').set(bearer(token)).send({ ...draft({ description: 'Sin rastro', lines: [{ name: 'Control', quantity: 1, unitPriceCents: 6600 }] }), idempotencyKey: randomUUID() }).expect(201);
      expect(u.body).toMatchObject({ docStatus: 'PENDING_RECONCILIATION', docStatusLabel: 'Enviado: número por confirmar' });
    } finally {
      appCfg.maxRealOperations = savedCap;
      scenario.registro = 'ok';
      scenario.facturacion = null;
    }
  });

  it('busca los nombres por DNI para precargar al paciente: usa lo que ya hay y solo consulta ClienteDoc si falta', async () => {
    const appCfg = ctx.app.get(AppConfig).apiworking as { maxRealOperations: number };
    const savedCap = appCfg.maxRealOperations;
    appCfg.maxRealOperations = 900;
    const login = await enter();
    const t = ((await ctx.http().post('/v1/auth/select-context').set(bearer(login.accessToken)).send({ clinicId, branchId: null }).expect(200)).body.accessToken as string);
    const llamadas = () => seen.filter((x) => x.path === '/api/Cliente/ClienteDoc').length;
    try {
      // Ya está en Apiworking con su nombre: no se escribe nada.
      const before = llamadas();
      const existing = await ctx.http().post('/v1/apiworking/clients/lookup').set(bearer(t)).send({ docType: '1', docNumber: '74908568' }).expect(200);
      expect(existing.body).toMatchObject({ status: 'FOUND', source: 'EXISTING', names: { firstName: 'ROBERTO CARLOS', lastName: 'ESPINAR', secondLastName: 'VICHARRA' } });
      expect(llamadas()).toBe(before);

      // No existe: ClienteDoc devuelve el nombre y se separa en nombres y apellidos.
      const found = await ctx.http().post('/v1/apiworking/clients/lookup').set(bearer(t)).send({ docType: '1', docNumber: '70000001' }).expect(200);
      expect(found.body).toMatchObject({ status: 'FOUND', source: 'LOOKUP', customerId: '202600000098', names: { firstName: 'JUAN CARLOS', lastName: 'PEREZ', secondLastName: 'GOMEZ' } });
      expect(llamadas()).toBe(before + 1);
      expect(await ctx.db.auditLog.count({ where: { action: 'APIWORKING_CUSTOMER_ATTEMPT' } })).toBeGreaterThan(0);

      // Repetirlo ya no escribe: el cliente quedó en el espejo con su nombre real.
      const again = await ctx.http().post('/v1/apiworking/clients/lookup').set(bearer(t)).send({ docType: '1', docNumber: '70000001' }).expect(200);
      expect(again.body).toMatchObject({ source: 'EXISTING', names: { firstName: 'JUAN CARLOS' } });
      expect(llamadas()).toBe(before + 1);

      // Sin nombre en la respuesta: se avisa para escribirlo a mano.
      const none = await ctx.http().post('/v1/apiworking/clients/lookup').set(bearer(t)).send({ docType: '1', docNumber: '70000002' }).expect(200);
      expect(none.body.status).toBe('NO_NAME');

      // Con el tope agotado no sale nada.
      appCfg.maxRealOperations = 1;
      const blocked = await ctx.http().post('/v1/apiworking/clients/lookup').set(bearer(t)).send({ docType: '1', docNumber: '70000003' });
      expect(blocked.status).toBe(409);
      expect(blocked.body.code).toBe('REAL_OPERATIONS_LIMIT');
    } finally {
      appCfg.maxRealOperations = savedCap;
    }
  });

  it('resume las ventas del día por forma de pago, sin contar las rechazadas', async () => {
    const t = await ctx.http().get('/v1/apiworking/sales/summary').set(bearer(token)).expect(200);
    expect(t.body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(t.body.count).toBeGreaterThan(0);
    expect(t.body.methods.reduce((n: number, m: { count: number }) => n + m.count, 0)).toBe(t.body.count);
    expect(t.body.methods.reduce((n: number, m: { totalCents: number }) => n + m.totalCents, 0)).toBe(t.body.totalCents);
    const empty = await ctx.http().get('/v1/apiworking/sales/summary').query({ date: '2020-01-01' }).set(bearer(token)).expect(200);
    expect(empty.body).toMatchObject({ count: 0, totalCents: 0, methods: [] });
    await ctx.http().get('/v1/apiworking/sales/summary').query({ date: 'ayer' }).set(bearer(token)).expect(400);
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
