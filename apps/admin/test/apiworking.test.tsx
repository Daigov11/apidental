import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach } from 'vitest';
import { CLINIC, mockApi, renderApp, sessionRoutes, USER } from './helpers';

afterEach(() => vi.unstubAllGlobals());

const PERMS = ['apiworking:read', 'apiworking:sell', 'apiworking:void', 'appointment:read', 'branch:read', 'clinic:read'];
const STATUS = { configured: true, read: true, write: true, tenant: 'prod_ti_tiendaglowsmile', session: true };
const CUSTOMER = { id: '202600000038', personId: '1', name: 'ROBERTO CARLOS ESPINAR VICHARRA', email: '', docType: 'D.N.I.', docNumber: '74908568', phone: '', whatsapp: '', personType: 'N', active: true };
const SALE = {
  id: 's-1', description: 'Limpieza dental', customer: { name: CUSTOMER.name, docType: 'D.N.I.', docNumber: '74908568' }, totalCents: 10000, totalText: 'S/ 100.00',
  lines: [{ name: 'Profilaxis', quantity: 2, unitPriceCents: 5000 }], docDate: '2026-11-02', serie: 'B001', docStatus: 'SENT', docStatusLabel: 'Registrado en Apiworking',
  paymentStatus: 'NO_EVIDENCE', paymentStatusLabel: 'Pago pendiente', voidStatus: null, voidStatusLabel: null, externalDocId: '201900000123', externalNumber: 'B001-00000123',
  failureReason: null, attemptedAt: '2026-11-02T15:00:00.000Z', createdAt: '2026-11-02T15:00:00.000Z', actions: { verify: true, reconcile: false, pay: true, void: true },
};
const CTX = {
  cajas: [{ id: '5', name: 'Caja Glow', branch: 'Principal' }], authorizedConfigured: true, opened: true,
  documentTypes: [{ id: '2', name: 'Boleta' }], series: [{ id: '11', serie: 'B001' }], paymentMethods: [{ id: '1', name: 'Efectivo' }],
};

const SUMMARY = { date: '2026-11-12', count: 3, totalCents: 25000, totalText: 'S/ 250.00', methods: [{ methodId: '1', name: 'Efectivo', count: 2, totalCents: 15000, totalText: 'S/ 150.00' }, { methodId: '2', name: 'Yape / Plin', count: 1, totalCents: 10000, totalText: 'S/ 100.00' }] };
const CASH = { cajas: [{ id: '5', name: 'Caja Glow', branch: 'Principal', opened: false }], turnos: [{ id: '1', name: 'Mañana' }], defaultTurn: '1', write: true };

type Routes = Parameters<typeof mockApi>[0];
const routes = (over: Routes = {}): Routes => ({
  ...sessionRoutes(PERMS, ['CLINIC_ADMIN']),
  'GET /appointments': { json: [] },
  'GET /integrations/status': { json: { mode: 'off', simulation: null } },
  'GET /apiworking/status': { json: STATUS },
  'GET /apiworking/sales': { json: { items: [SALE], total: 1 } },
  'GET /apiworking/clients': { json: { items: [CUSTOMER], total: 1 } },
  'GET /apiworking/sales/context': { json: CTX },
  'GET /apiworking/cash': { json: CASH },
  'GET /apiworking/sales/summary': { json: SUMMARY },
  'GET /auth/config': { json: { mode: 'apiworking' } },
  'GET /cashbox/summary': { json: { branch: { id: 'b', name: 'Sede' }, register: null, session: null, lastClosedAt: null, accounts: [], totals: { openingCents: 0, incomeCents: 0, expenseCents: 0, balanceCents: 0 } } },
  'GET /cashbox/config': { json: { accounts: [], categories: [], users: [] } },
  'GET /cashbox/movements': { json: { items: [], total: 0, incomeCents: 0, expenseCents: 0 } },
  ...over,
});

describe('Acceso con Apiworking', () => {
  it('con AUTH_MODE=apiworking el ingreso principal es el usuario de Apiworking y el administrador local sigue disponible', async () => {
    const { called } = mockApi({
      'POST /auth/refresh': { status: 401, json: {} },
      'GET /auth/config': { json: { mode: 'apiworking' } },
      'POST /auth/apiworking-login': { json: { accessToken: 't', user: USER, contexts: [], pendingAccess: true } },
      'POST /auth/login': { status: 401, json: { message: 'Credenciales inválidas' } },
    });
    renderApp('/');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Usuario de Apiworking'), 'gina');
    await user.type(screen.getByLabelText('Contraseña'), 'clave-apiworking');
    await user.click(screen.getByRole('button', { name: 'Ingresar' }));
    // Cuenta válida pero sin rol local: «acceso pendiente», nunca entra al panel.
    expect(await screen.findByText(/todavía no tiene un rol en esta clínica/)).toBeInTheDocument();
    expect(called('POST', '/auth/apiworking-login')[0]?.body).toEqual({ usuario: 'gina', password: 'clave-apiworking' });
    expect(called('POST', '/auth/login')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Ingresar con correo' }));
    expect(screen.getByLabelText('Correo')).toBeInTheDocument();
    expect(screen.queryByLabelText('Usuario de Apiworking')).not.toBeInTheDocument();
  });

  it('credenciales de Apiworking incorrectas: mensaje genérico', async () => {
    mockApi({ 'POST /auth/refresh': { status: 401, json: {} }, 'GET /auth/config': { json: { mode: 'apiworking' } }, 'POST /auth/apiworking-login': { status: 401, json: { message: 'Credenciales inválidas' } } });
    renderApp('/');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Usuario de Apiworking'), 'gina');
    await user.type(screen.getByLabelText('Contraseña'), 'mala');
    await user.click(screen.getByRole('button', { name: 'Ingresar' }));
    expect(await screen.findByText('Usuario o contraseña de Apiworking incorrectos.')).toBeInTheDocument();
  });

  it('en modo local no ofrece el ingreso de Apiworking', async () => {
    mockApi({ 'POST /auth/refresh': { status: 401, json: {} }, 'GET /auth/config': { json: { mode: 'local' } } });
    renderApp('/');
    expect(await screen.findByLabelText('Correo')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ingresar con correo' })).not.toBeInTheDocument();
  });
});

describe('Configuración de Apiworking', () => {
  it('no se muestra en Ventas, ni siquiera al administrador', async () => {
    mockApi(routes({ ...sessionRoutes([...PERMS, 'apiworking:configure'], ['CLINIC_ADMIN']) }));
    renderApp('/ventas');
    await screen.findByText('Limpieza dental');
    expect(screen.queryByRole('heading', { name: 'Configuración de Apiworking' })).not.toBeInTheDocument();
  });
});

describe('Ventas Apiworking', () => {
  it('el menú muestra Ventas solo con el permiso apiworking:read', async () => {
    mockApi(routes());
    renderApp('/');
    await screen.findByRole('heading', { name: 'Hoy' });
    expect(within(screen.getByRole('navigation', { name: 'Principal' })).getByRole('link', { name: 'Ventas' })).toBeInTheDocument();
  });

  it('sin la sesión de Apiworking avisa que debe volver a ingresar y no deja preparar ventas', async () => {
    mockApi(routes({ 'GET /apiworking/status': { json: { ...STATUS, session: false } } }));
    renderApp('/ventas');
    expect(await screen.findByText('Vuelva a ingresar')).toBeInTheDocument();
    expect(screen.queryByLabelText('Buscar cliente')).not.toBeInTheDocument();
  });

  it('lista las ventas con documento y cobro como estados separados', async () => {
    mockApi(routes());
    renderApp('/ventas');
    const row = (await screen.findByText('Limpieza dental')).closest('tr')!;
    expect(within(row).getByText('Registrado en Apiworking')).toBeInTheDocument();
    expect(within(row).getByText('Pago pendiente')).toBeInTheDocument();
    expect(within(row).getByText('B001-00000123')).toBeInTheDocument();
  });

  it('venta directa: «Cobrar» registra y paga en un clic, con la caja de la sesión y sin aprobación', async () => {
    const { called } = mockApi(routes({ 'POST /apiworking/sales': { status: 201, json: { ...SALE, paymentStatus: 'CONFIRMED_REMOTE', paymentStatusLabel: 'Pagado' } } }));
    renderApp('/ventas');
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Nueva venta' });

    await user.type(screen.getByLabelText('Buscar cliente'), 'robert');
    await user.click(await screen.findByRole('button', { name: /ROBERTO CARLOS/ }));
    // La caja es la de la sesión: no se elige. Con un solo tipo y una sola serie, todo queda elegido; la forma de pago arranca en Efectivo.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Efectivo' })).toHaveAttribute('aria-pressed', 'true'));
    expect(screen.queryByLabelText('Caja')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Serie')).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Concepto 1'), 'Profilaxis');
    await user.clear(screen.getByLabelText('Cantidad'));
    await user.type(screen.getByLabelText('Cantidad'), '2');
    await user.type(screen.getByLabelText(/Precio unitario/), '50');

    // Sin revisión del JSON ni casilla de aprobación.
    expect(screen.queryByRole('button', { name: 'Revisar venta' })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cobrar S/ 100.00' }));

    await waitFor(() => expect(called('POST', '/apiworking/sales')).toHaveLength(1));
    expect(called('POST', '/apiworking/sales/preview')).toHaveLength(0);
    const sent = called('POST', '/apiworking/sales')[0]!.body as Record<string, unknown>;
    expect(sent).toMatchObject({ customerId: '202600000038', idCaja: '5', idTipoDocumento: '2', idSerie: '11', idMetodoPago: '1', description: 'Profilaxis', lines: [{ name: 'Profilaxis', quantity: 2, unitPriceCents: 5000 }] });
    expect(sent).not.toHaveProperty('approvedHash');
    expect(sent['idempotencyKey']).toMatch(/^[0-9a-f-]{36}$/);
    expect(await screen.findByText('Venta B001-00000123 registrada y pagada en Apiworking.')).toBeInTheDocument();
  });

  it('en modo de solo lectura no se puede cobrar', async () => {
    mockApi(routes({ 'GET /apiworking/status': { json: { ...STATUS, write: false } } }));
    renderApp('/ventas');
    const user = userEvent.setup();
    expect(await screen.findByText('Modo de solo lectura')).toBeInTheDocument();
    await user.type(await screen.findByLabelText('Buscar cliente'), 'robert');
    await user.click(await screen.findByRole('button', { name: /ROBERTO CARLOS/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Efectivo' })).toHaveAttribute('aria-pressed', 'true'));
    await user.type(screen.getByLabelText('Concepto 1'), 'Consulta');
    await user.type(screen.getByLabelText(/Precio unitario/), '50');
    expect(screen.getByRole('button', { name: 'Cobrar S/ 50.00' })).toBeDisabled();
  });

  it('una venta con número por confirmar no muestra Verificar ni Conciliar', async () => {
    const unknown = { ...SALE, id: 's-2', docStatus: 'PENDING_RECONCILIATION', docStatusLabel: 'Enviado: número por confirmar', failureReason: 'Resultado desconocido: Apiworking pudo registrar el documento. Verifique antes de reenviar', externalDocId: null, externalNumber: null, actions: { verify: true, reconcile: true, pay: false, void: false } };
    mockApi(routes({ 'GET /apiworking/sales': { json: { items: [unknown], total: 1 } } }));
    renderApp('/ventas');
    expect(await screen.findByText('Enviado: número por confirmar')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Verificar' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Conciliar' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Verifique antes de reenviar/)).not.toBeInTheDocument();
  });

  it('anular pide un motivo y solo aparece con el permiso apiworking:void', async () => {
    const { called } = mockApi(routes({ 'POST /apiworking/sales/s-1/void': { json: { ...SALE, voidStatus: 'IN_PROGRESS' } } }));
    renderApp('/ventas');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Anular' }));
    const dialog = await screen.findByRole('dialog', { name: 'Anular venta en Apiworking' });
    await user.type(within(dialog).getByLabelText('Motivo'), 'Error en el monto');
    await user.click(within(dialog).getByRole('button', { name: 'Anular venta' }));
    await waitFor(() => expect(called('POST', '/apiworking/sales/s-1/void')).toHaveLength(1));
    expect(called('POST', '/apiworking/sales/s-1/void')[0]?.body).toEqual({ reason: 'Error en el monto' });
  });

  it('sin permiso de anular no se ofrece el botón, y nunca Registrar pago ni Verificar', async () => {
    mockApi(routes({ ...sessionRoutes(['apiworking:read', 'apiworking:sell', 'appointment:read', 'branch:read', 'clinic:read'], ['RECEPTIONIST']) }));
    renderApp('/ventas');
    await screen.findByText('Limpieza dental');
    expect(screen.queryByRole('button', { name: 'Anular' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Verificar' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Registrar pago' })).not.toBeInTheDocument();
  });
});

describe('Apertura y cierre de caja', () => {
  it('«Abrir caja» abre en un clic con el monto inicial, sin vista previa ni aprobación', async () => {
    const { called } = mockApi(routes({
      ...sessionRoutes([...PERMS, 'apiworking:cash', 'cashbox:read'], ['CLINIC_ADMIN']),
      'POST /apiworking/cash/open': { json: { status: 'OPENED', message: 'Caja abierta', movementId: '9001' } },
    } as never));
    renderApp('/caja-chica');
    const user = userEvent.setup();
    const card = (await screen.findByRole('heading', { name: 'Caja de Apiworking' })).closest('section')!;
    await user.clear(await within(card).findByLabelText(/Monto inicial/));
    await user.type(within(card).getByLabelText(/Monto inicial/), '100');
    expect(within(card).queryByRole('checkbox')).not.toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Abrir caja' }));
    await waitFor(() => expect(called('POST', '/apiworking/cash/open')).toHaveLength(1));
    expect(called('POST', '/apiworking/cash/open')[0]?.body).toEqual({ idCaja: '5', openingCents: 10000, idTurno: '1' });
    expect(called('POST', '/apiworking/cash/preview')).toHaveLength(0);
    expect(await screen.findByText('Caja abierta en Apiworking')).toBeInTheDocument();
  });

  it('«Cerrar caja» cierra en un clic', async () => {
    const { called } = mockApi(routes({
      ...sessionRoutes([...PERMS, 'apiworking:cash', 'cashbox:read'], ['CLINIC_ADMIN']),
      'GET /apiworking/cash': { json: { ...CASH, cajas: [{ id: '5', name: 'Caja Glow', branch: 'Principal', opened: true }] } },
      'POST /apiworking/cash/close': { json: { status: 'CLOSED', message: 'Caja cerrada' } },
    } as never));
    renderApp('/caja-chica');
    const user = userEvent.setup();
    const card = (await screen.findByRole('heading', { name: 'Caja de Apiworking' })).closest('section')!;
    await user.click(await within(card).findByRole('button', { name: 'Cerrar caja' }));
    await waitFor(() => expect(called('POST', '/apiworking/cash/close')).toHaveLength(1));
    expect(called('POST', '/apiworking/cash/close')[0]?.body).toEqual({ idCaja: '5' });
    expect(called('POST', '/apiworking/cash/close-preview')).toHaveLength(0);
  });

  it('sin el permiso apiworking:cash se ve el estado pero no se ofrece abrir ni cerrar', async () => {
    mockApi(routes(sessionRoutes([...PERMS, 'cashbox:read'], ['CLINIC_ADMIN']) as never));
    renderApp('/caja-chica');
    const card = (await screen.findByRole('heading', { name: 'Caja de Apiworking' })).closest('section')!;
    expect(await within(card).findByText('Cerrada')).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Abrir caja' })).not.toBeInTheDocument();
  });
});

describe('Ventas del día en la caja chica', () => {
  it('muestra cuántas ventas hubo con cada forma de pago', async () => {
    mockApi(routes(sessionRoutes([...PERMS, 'cashbox:read'], ['CLINIC_ADMIN']) as never));
    renderApp('/caja-chica');
    const card = (await screen.findByRole('heading', { name: 'Ventas de hoy por forma de pago' })).closest('section')!;
    expect(await within(card).findByText('Yape / Plin')).toBeInTheDocument();
    expect(within(card).getByText('S/ 150.00')).toBeInTheDocument();
    expect(within(card).getByText('S/ 250.00')).toBeInTheDocument();
  });
});

describe('Cliente por documento', () => {
  it('se crea en un clic, sin casilla de aprobación; el cliente creado queda elegido', async () => {
    const { called } = mockApi(routes({
      'GET /apiworking/clients': { json: { items: [], total: 0 } },
      'POST /apiworking/clients/preview': { json: { hash: 'c'.repeat(64), docType: '1', docTypeLabel: 'DNI', docNumber: '74908568', exists: null, write: true } },
      'POST /apiworking/clients': { json: { status: 'CREATED', id: CUSTOMER.id, customer: CUSTOMER } },
    }));
    renderApp('/ventas');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Crear cliente por documento' }));
    await user.type(screen.getByLabelText('Número de documento'), '74908568');
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Crear cliente' }));
    await waitFor(() => expect(called('POST', '/apiworking/clients')).toHaveLength(1));
    expect(called('POST', '/apiworking/clients')[0]?.body).toEqual({ docType: '1', docNumber: '74908568', approvedHash: 'c'.repeat(64) });
    expect(await screen.findByRole('button', { name: 'Cambiar' })).toBeInTheDocument();
  });

  it('si el documento ya existe en Apiworking, se elige sin crear nada', async () => {
    const { called } = mockApi(routes({
      'GET /apiworking/clients': { json: { items: [], total: 0 } },
      'POST /apiworking/clients/preview': { json: { hash: 'c'.repeat(64), docType: '1', docTypeLabel: 'DNI', docNumber: '74908568', exists: { id: CUSTOMER.id, name: CUSTOMER.name }, write: true } },
    }));
    renderApp('/ventas');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Crear cliente por documento' }));
    await user.type(screen.getByLabelText('Número de documento'), '74908568');
    await user.click(screen.getByRole('button', { name: 'Crear cliente' }));
    expect(await screen.findByRole('button', { name: 'Cambiar' })).toBeInTheDocument();
    expect(called('POST', '/apiworking/clients')).toHaveLength(0);
  });
});

describe('Contingencia', () => {
  const CASH_PERMS = [...PERMS, 'cashbox:read', 'cashbox:write'];
  const LOCAL = {
    'GET /cashbox/config': { json: { accounts: [{ id: 'acc-1', name: 'Efectivo', kind: 'CASH', kindLabel: 'Efectivo', allowNegative: false, active: true }], categories: [{ id: 'cat-1', flow: 'INCOME', name: 'Cobro de atención', active: true }], users: [] } },
    'GET /cashbox/summary': { json: { branch: { id: 'b', name: 'Sede' }, register: { id: 'r', name: 'Caja' }, session: { id: 'ses', openedAt: '2026-11-02T14:00:00.000Z', openedBy: 'Gina', openNotes: null }, lastClosedAt: null, accounts: [], totals: { openingCents: 0, incomeCents: 0, expenseCents: 0, balanceCents: 0 } } },
  };

  it('cobra en la caja local con aprobación y sin llamar a la venta de Apiworking', async () => {
    const { called } = mockApi(routes({
      ...sessionRoutes(CASH_PERMS, ['CLINIC_ADMIN']),
      ...LOCAL,
      'POST /apiworking/contingency': { json: { ...SALE, id: 'c-1', docStatus: 'PENDING_ISSUE', contingency: true } },
    } as never));
    renderApp('/ventas');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Apiworking no responde: cobrar en contingencia' }));
    expect(await screen.findByText('Modo contingencia')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: new RegExp(CUSTOMER.name) }));
    await user.type(screen.getByLabelText('Concepto 1'), 'Profilaxis');
    await user.type(screen.getByLabelText(/Precio unitario/), '50');
    await user.selectOptions(await screen.findByLabelText('Cuenta o medio de pago'), 'acc-1');
    await user.selectOptions(screen.getByLabelText('Tipo de operación'), 'cat-1');
    const go = screen.getByRole('button', { name: 'Registrar cobro en contingencia' });
    expect(go).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: /autorizo cobrar en la caja local/ }));
    await user.click(go);
    await waitFor(() => expect(called('POST', '/apiworking/contingency')).toHaveLength(1));
    const body = called('POST', '/apiworking/contingency')[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({ customerId: CUSTOMER.id, description: 'Profilaxis', accountId: 'acc-1', categoryId: 'cat-1', lines: [{ name: 'Profilaxis', quantity: 1, unitPriceCents: 5000 }] });
    expect(body['requestKey']).toMatch(/^[0-9a-f-]{36}$/);
    expect(called('POST', '/apiworking/sales')).toHaveLength(0);
  });

  it('una venta por emitir ofrece «Emitir en Apiworking» y bloquea cliente y monto', async () => {
    const pending = { ...SALE, id: 's-9', customerId: CUSTOMER.id, docStatus: 'PENDING_ISSUE', docStatusLabel: 'Cobrado en contingencia: por emitir', contingency: true, actions: { issue: true, verify: false, reconcile: false, void: false } };
    mockApi(routes({ 'GET /apiworking/sales': { json: { items: [pending], total: 1 } } }));
    renderApp('/ventas');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Emitir en Apiworking' }));
    expect(await screen.findByText('Emitiendo una venta cobrada en contingencia')).toBeInTheDocument();
    expect(screen.getByLabelText('Fecha del documento')).toHaveValue('2026-11-02');
    expect(await screen.findByRole('button', { name: 'Cambiar' })).toBeInTheDocument();
  });

  it('desde una cita atendida: cliente, servicio y precio quedan prellenados', async () => {
    mockApi(routes({
      'GET /apiworking/billing-draft': { json: { patient: { id: 'p-1', name: 'Diego Mendieta' }, appointment: { id: 'a-1', status: 'ATTENDED' }, description: 'Limpieza dental', amountCents: 8000, identifier: { docType: '1', docTypeLabel: 'DNI', docNumber: '74908568' }, customer: CUSTOMER, alreadyBilled: null, canBill: true } },
    }));
    renderApp('/ventas?appointmentId=a-1');
    expect(await screen.findByText('Cobro de Diego Mendieta')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Cambiar' })).toBeInTheDocument();
    expect(screen.getByLabelText('Concepto 1')).toHaveValue('Limpieza dental');
    expect(screen.getByLabelText(/Precio unitario/)).toHaveValue('80.00');
  });

  it('la receta del odontólogo aparece en el cobro: se agrega lo recetado con su precio o se cobra solo el servicio', async () => {
    const RX = { id: 'rx-1', number: 12, code: 'RX-000012', prescriber: 'Gina Paredes', createdAt: '2026-11-12T15:00:00.000Z', items: [
      { medication: 'Amoxicilina', dose: '500 mg', frequency: 'cada 8 horas', duration: '7 días' },
      { medication: 'Ibuprofeno', dose: '400 mg', frequency: 'cada 8 horas', duration: '3 días' },
    ] };
    const { called } = mockApi(routes({
      'GET /apiworking/billing-draft': { json: { patient: { id: 'p-1', name: 'Diego Mendieta' }, appointment: { id: 'a-1', status: 'ATTENDED' }, description: 'Extracción', amountCents: 15000, identifier: { docType: '1', docTypeLabel: 'DNI', docNumber: '74908568' }, customer: CUSTOMER, alreadyBilled: null, canBill: true, prescriptions: [RX] } },
      'POST /apiworking/sales': { status: 201, json: { ...SALE, paymentStatus: 'CONFIRMED_REMOTE' } },
    }));
    renderApp('/ventas?appointmentId=a-1');
    const user = userEvent.setup();
    const card = (await screen.findByRole('heading', { name: 'Receta del odontólogo' })).closest('section')!;
    expect(within(card).getByText('RX-000012')).toBeInTheDocument();
    expect(within(card).getByText(/Gina Paredes/)).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Agregar Amoxicilina a la venta' }));
    expect(screen.getByLabelText('Concepto 2')).toHaveValue('Amoxicilina 500 mg');
    expect(within(card).getByRole('button', { name: 'Amoxicilina ya está en la venta' })).toBeDisabled();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Efectivo' })).toHaveAttribute('aria-pressed', 'true'));
    const prices = screen.getAllByLabelText(/Precio unitario/);
    await user.type(prices[1]!, '25');
    await user.click(screen.getByRole('button', { name: 'Cobrar S/ 175.00' }));
    await waitFor(() => expect(called('POST', '/apiworking/sales')).toHaveLength(1));
    expect((called('POST', '/apiworking/sales')[0]!.body as { lines: unknown[] }).lines).toEqual([
      { name: 'Extracción', quantity: 1, unitPriceCents: 15000 },
      { name: 'Amoxicilina 500 mg', quantity: 1, unitPriceCents: 2500 },
    ]);
  });
});

void CLINIC;
