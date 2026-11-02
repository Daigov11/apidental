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
  paymentStatus: 'NO_EVIDENCE', paymentStatusLabel: 'Cobro sin confirmar', voidStatus: null, voidStatusLabel: null, externalDocId: '201900000123', externalNumber: 'B001-00000123',
  failureReason: null, attemptedAt: '2026-11-02T15:00:00.000Z', createdAt: '2026-11-02T15:00:00.000Z', actions: { verify: true, reconcile: false, void: true },
};
const CTX = {
  cajas: [{ id: '5', name: 'Caja Glow', branch: 'Principal' }], authorizedConfigured: true, opened: true,
  documentTypes: [{ id: '2', name: 'Boleta' }], series: [{ id: '11', serie: 'B001' }], paymentMethods: [{ id: '1', name: 'Efectivo' }],
};

type Routes = Parameters<typeof mockApi>[0];
const routes = (over: Routes = {}): Routes => ({
  ...sessionRoutes(PERMS, ['CLINIC_ADMIN']),
  'GET /appointments': { json: [] },
  'GET /integrations/status': { json: { mode: 'off', simulation: null } },
  'GET /apiworking/status': { json: STATUS },
  'GET /apiworking/sales': { json: { items: [SALE], total: 1 } },
  'GET /apiworking/clients': { json: { items: [CUSTOMER], total: 1 } },
  'GET /apiworking/sales/context': { json: CTX },
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

    await user.click(screen.getByRole('button', { name: 'Acceso del administrador local' }));
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
    expect(screen.queryByRole('button', { name: 'Acceso del administrador local' })).not.toBeInTheDocument();
  });
});

describe('Configuración de Apiworking (descubrimiento)', () => {
  const DISC = { cajas: [{ id: '5', name: 'Caja Glow', branch: 'Principal', authorized: false }, { id: '6', name: 'Otra', branch: '', authorized: false }], write: false, warehouseId: null, unitId: null };

  it('el administrador ve todas las cajas y obtiene los valores para el servidor; sin el permiso no aparece', async () => {
    const { called } = mockApi(routes({
      ...sessionRoutes([...PERMS, 'apiworking:configure'], ['CLINIC_ADMIN']),
      'GET /apiworking/discovery': (c: { query: URLSearchParams }) => ({ json: c.query.get('idTipoDocumento') ? { ...DISC, opened: true, documentTypes: [{ id: '2', name: 'Boleta', authorized: false }], series: [{ id: '11', serie: 'B001', authorized: false }, { id: '12', serie: 'B002', authorized: false }], paymentMethods: [{ id: '1', name: 'Efectivo' }] } : c.query.get('idCaja') ? { ...DISC, opened: true, documentTypes: [{ id: '2', name: 'Boleta', authorized: false }] } : DISC }),
    } as never));
    renderApp('/ventas');
    const user = userEvent.setup();
    const card = (await screen.findByRole('heading', { name: 'Configuración de Apiworking' })).closest('section')!;
    await user.selectOptions(await within(card).findByLabelText('Caja'), '5');
    await user.selectOptions(await within(card).findByLabelText('Tipo de documento'), '2');
    expect(await within(card).findByText('B002')).toBeInTheDocument();
    const env = within(card).getByText(/APIWORKING_AUTHORIZED_CASH_REGISTERS=5/);
    expect(env.textContent).toContain('APIWORKING_AUTHORIZED_DOCUMENT_TYPES=2');
    expect(env.textContent).toContain('APIWORKING_AUTHORIZED_SERIES=11,12');
    expect(env.textContent).toContain('APIWORKING_WAREHOUSE_ID=<id del almacén>');
    // Solo lectura: nada se envía al servidor.
    expect(called('POST', '/apiworking/sales')).toHaveLength(0);
  });

  it('sin apiworking:configure no se muestra', async () => {
    mockApi(routes());
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
    expect(screen.queryByRole('heading', { name: 'Nueva venta' })).not.toBeInTheDocument();
  });

  it('lista las ventas con documento y cobro como estados separados', async () => {
    mockApi(routes());
    renderApp('/ventas');
    const row = (await screen.findByText('Limpieza dental')).closest('tr')!;
    expect(within(row).getByText('Registrado en Apiworking')).toBeInTheDocument();
    expect(within(row).getByText('Cobro sin confirmar')).toBeInTheDocument();
    expect(within(row).getByText('B001-00000123')).toBeInTheDocument();
  });

  it('flujo completo: cliente, caja, detalle, revisión del JSON y envío con aprobación e idempotencia', async () => {
    const hash = 'a'.repeat(64);
    const { called } = mockApi(routes({
      'POST /apiworking/sales/preview': { json: { request: { idCaja: '5', totalVenta: 0 }, hash, totalCents: 10000, totalText: 'S/ 100.00', serie: 'B001', customer: CUSTOMER, suggestedDocument: 'BOLETA', mode: 'LIVE', writeEnabled: true, warnings: ['Apiworking registra el documento, pero NO aplica el cobro'] } },
      'POST /apiworking/sales': { status: 201, json: SALE },
    }));
    renderApp('/ventas');
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Nueva venta' });

    await user.type(screen.getByLabelText('Buscar cliente'), 'robert');
    await user.click(await screen.findByRole('button', { name: /ROBERTO CARLOS/ }));
    await user.selectOptions(screen.getByLabelText('Caja'), '5');
    await user.selectOptions(await screen.findByLabelText('Tipo de documento'), '2');
    await user.selectOptions(await screen.findByLabelText('Serie'), '11');
    await user.selectOptions(await screen.findByLabelText('Forma de pago'), '1');
    await user.type(screen.getByLabelText('Descripción'), 'Limpieza dental');
    await user.type(screen.getByLabelText('Concepto 1'), 'Profilaxis');
    await user.clear(screen.getByLabelText('Cantidad'));
    await user.type(screen.getByLabelText('Cantidad'), '2');
    await user.type(screen.getByLabelText(/Precio unitario/), '50');
    expect(screen.getByText('Total S/ 100.00')).toBeInTheDocument();

    // Sin revisión no hay envío.
    expect(screen.queryByRole('button', { name: 'Enviar a Apiworking' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Revisar venta' }));
    const region = await screen.findByRole('region', { name: 'Revisión antes de enviar' });
    expect(called('POST', '/apiworking/sales/preview')[0]?.body).toMatchObject({ customerId: '202600000038', idCaja: '5', idTipoDocumento: '2', idSerie: '11', idMetodoPago: '1', description: 'Limpieza dental', lines: [{ name: 'Profilaxis', quantity: 2, unitPriceCents: 5000 }] });
    expect(within(region).getByText(hash)).toBeInTheDocument();
    expect(within(region).getByText(/Boleta \(según el documento del cliente\)/)).toBeInTheDocument();

    // Sin aprobar explícitamente, el botón está desactivado.
    const sendBtn = screen.getByRole('button', { name: 'Enviar a Apiworking' });
    expect(sendBtn).toBeDisabled();
    await user.click(within(region).getByRole('checkbox'));
    expect(sendBtn).toBeEnabled();

    // Cambiar algo invalida la aprobación y obliga a revisar de nuevo.
    await user.type(screen.getByLabelText('Descripción'), ' y control');
    expect(screen.queryByRole('button', { name: 'Enviar a Apiworking' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Revisar venta' }));
    await user.click(within(await screen.findByRole('region', { name: 'Revisión antes de enviar' })).getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Enviar a Apiworking' }));

    await waitFor(() => expect(called('POST', '/apiworking/sales')).toHaveLength(1));
    const sent = called('POST', '/apiworking/sales')[0]!.body as { approvedHash: string; idempotencyKey: string; description: string };
    expect(sent).toMatchObject({ approvedHash: hash, description: 'Limpieza dental y control' });
    expect(sent.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(await screen.findByText(/Venta registrada en Apiworking/)).toBeInTheDocument();
  });

  it('en modo de solo lectura se puede revisar pero no aprobar ni enviar', async () => {
    mockApi(routes({
      'GET /apiworking/status': { json: { ...STATUS, write: false } },
      'POST /apiworking/sales/preview': { json: { request: {}, hash: 'b'.repeat(64), totalCents: 5000, totalText: 'S/ 50.00', serie: 'B001', customer: CUSTOMER, suggestedDocument: 'BOLETA', mode: 'READ_ONLY', writeEnabled: false, warnings: [] } },
    }));
    renderApp('/ventas');
    const user = userEvent.setup();
    expect(await screen.findByText('Modo de solo lectura')).toBeInTheDocument();
    await user.type(await screen.findByLabelText('Buscar cliente'), 'robert');
    await user.click(await screen.findByRole('button', { name: /ROBERTO CARLOS/ }));
    await user.selectOptions(screen.getByLabelText('Caja'), '5');
    await user.selectOptions(await screen.findByLabelText('Tipo de documento'), '2');
    await user.selectOptions(await screen.findByLabelText('Serie'), '11');
    await user.selectOptions(await screen.findByLabelText('Forma de pago'), '1');
    await user.type(screen.getByLabelText('Descripción'), 'Consulta');
    await user.type(screen.getByLabelText('Concepto 1'), 'Consulta');
    await user.type(screen.getByLabelText(/Precio unitario/), '50');
    await user.click(screen.getByRole('button', { name: 'Revisar venta' }));
    const region = await screen.findByRole('region', { name: 'Revisión antes de enviar' });
    expect(within(region).getByRole('checkbox')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Enviar a Apiworking' })).toBeDisabled();
  });

  it('un resultado desconocido se concilia con evidencia: exige el número si el documento existe', async () => {
    const unknown = { ...SALE, id: 's-2', docStatus: 'PENDING_RECONCILIATION', docStatusLabel: 'Resultado desconocido: conciliar', externalDocId: null, externalNumber: null, actions: { verify: true, reconcile: true, void: false } };
    const { called } = mockApi(routes({
      'GET /apiworking/sales': { json: { items: [unknown], total: 1 } },
      'POST /apiworking/sales/s-2/reconcile': { json: { ...unknown, docStatus: 'SENT' } },
    }));
    renderApp('/ventas');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Conciliar' }));
    const dialog = await screen.findByRole('dialog', { name: 'Conciliar resultado desconocido' });
    const save = within(dialog).getByRole('button', { name: 'Guardar decisión' });
    await user.type(within(dialog).getByLabelText('Nota'), 'Lo vi en Apiworking');
    expect(save).toBeDisabled(); // «sí existe» sin número de comprobante
    await user.type(within(dialog).getByLabelText('Número de comprobante'), 'B001-00000124');
    await user.click(save);
    await waitFor(() => expect(called('POST', '/apiworking/sales/s-2/reconcile')).toHaveLength(1));
    expect(called('POST', '/apiworking/sales/s-2/reconcile')[0]?.body).toEqual({ outcome: 'REGISTERED', note: 'Lo vi en Apiworking', externalNumber: 'B001-00000124' });
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

  it('sin permiso de anular no se ofrece el botón', async () => {
    mockApi(routes({ ...sessionRoutes(['apiworking:read', 'apiworking:sell', 'appointment:read', 'branch:read', 'clinic:read'], ['RECEPTIONIST']) }));
    renderApp('/ventas');
    await screen.findByText('Limpieza dental');
    expect(screen.queryByRole('button', { name: 'Anular' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Verificar' })).toBeInTheDocument();
  });
});

void CLINIC;
