import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockApi, renderApp, sessionRoutes } from './helpers';

const ADMIN = ['agenda:manage', 'cashbox:manage', 'apiworking:read', 'apiworking:sell', 'branch:read', 'clinic:read'];
const AMOX = { id: 'p-1', name: 'Amoxicilina 500 mg', presentation: 'caja x 21', priceCents: 2500, active: true };
const IBU = { id: 'p-2', name: 'Ibuprofeno 400 mg', presentation: null, priceCents: 800, active: false };
const CUSTOMER = { id: '202600000038', personId: '1', name: 'DIEGO MENDIETA', email: '', docType: 'D.N.I.', docNumber: '74908568', phone: '', whatsapp: '', personType: 'N', active: true };

const base = (perms = ADMIN, over: Record<string, unknown> = {}) => ({
  ...sessionRoutes(perms, ['CLINIC_ADMIN']),
  'GET /appointments': { json: [] },
  'GET /integrations/status': { json: { mode: 'off', simulation: null } },
  'GET /auth/config': { json: { mode: 'apiworking' } },
  'GET /products': (c: { query: URLSearchParams }) => ({ json: c.query.get('all') === '1' ? [AMOX, IBU] : [AMOX] }),
  ...over,
});

describe('Catálogo', () => {
  it('el menú muestra Catálogo a quien administra la agenda o la caja', async () => {
    mockApi(base() as never);
    renderApp('/');
    expect(await within(await screen.findByRole('navigation', { name: 'Principal' })).findByRole('link', { name: 'Catálogo' })).toBeInTheDocument();
  });

  it('lista activos e inactivos, crea un producto con su precio y desactiva otro', async () => {
    const { called } = mockApi(base(ADMIN, {
      'POST /products': { status: 201, json: { id: 'p-3', name: 'Paracetamol 500 mg', presentation: null, priceCents: 350, active: true } },
      'PATCH /products/p-1': { json: { ...AMOX, active: false } },
    }) as never);
    renderApp('/catalogo');
    const user = userEvent.setup();
    expect(await screen.findByText('Amoxicilina 500 mg')).toBeInTheDocument();
    expect(screen.getByText('Ibuprofeno 400 mg').closest('tr')!).toHaveTextContent('Inactivo');
    await user.click(screen.getByRole('button', { name: 'Nuevo producto o servicio' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nuevo producto o servicio' });
    await user.selectOptions(within(dialog).getByLabelText('Tipo'), 'PRODUCT');
    await user.type(within(dialog).getByLabelText(/^Nombre/), 'Paracetamol 500 mg');
    await user.type(within(dialog).getByLabelText(/Precio de venta/), '3.50');
    await user.click(within(dialog).getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(called('POST', '/products')).toHaveLength(1));
    expect(called('POST', '/products')[0]?.body).toEqual({ name: 'Paracetamol 500 mg', presentation: '', priceCents: 350, kind: 'PRODUCT' });
    await user.click(within(screen.getByText('Amoxicilina 500 mg').closest('tr')!).getByRole('button', { name: 'Desactivar' }));
    await waitFor(() => expect(called('PATCH', '/products/p-1')).toHaveLength(1));
    expect(called('PATCH', '/products/p-1')[0]?.body).toEqual({ active: false });
  });

  it('en caja, lo recetado que está en el catálogo trae su precio y se puede agregar cualquier producto', async () => {
    const RX = { id: 'rx-1', number: 12, code: 'RX-000012', prescriber: 'Gina Paredes', createdAt: '2026-11-12T15:00:00.000Z', items: [
      { medication: 'Amoxicilina', dose: '500 mg', frequency: 'cada 8 horas', duration: '7 días', product: { id: 'p-1', name: 'Amoxicilina 500 mg', priceCents: 2500 } },
      { medication: 'Clorhexidina', dose: null, frequency: null, duration: null, product: null },
    ] };
    mockApi(base(ADMIN, {
      'GET /apiworking/status': { json: { configured: true, read: true, write: true, tenant: 't', session: true } },
      'GET /apiworking/sales': { json: { items: [], total: 0 } },
      'GET /apiworking/clients': { json: { items: [CUSTOMER], total: 1 } },
      'GET /apiworking/sales/context': { json: { cajas: [{ id: '5', name: 'Caja', branch: '' }], authorizedConfigured: false, opened: true, documentTypes: [{ id: '2', name: 'Boleta' }], series: [{ id: '11', serie: 'B001' }], paymentMethods: [{ id: '1', name: 'Efectivo' }] } },
      'GET /apiworking/billing-draft': { json: { patient: { id: 'pa-1', name: 'Diego Mendieta' }, appointment: { id: 'a-1', status: 'ATTENDED' }, description: 'Extracción', amountCents: 15000, identifier: null, customer: CUSTOMER, alreadyBilled: null, canBill: true, prescriptions: [RX] } },
    }) as never);
    renderApp('/ventas?appointmentId=a-1');
    const user = userEvent.setup();
    const card = (await screen.findByRole('heading', { name: 'Receta del odontólogo' })).closest('section')!;
    expect(within(card).getByText('sin precio en el catálogo', { exact: false })).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Agregar Amoxicilina a la venta' }));
    expect(screen.getByLabelText('Concepto 2')).toHaveValue('Amoxicilina 500 mg');
    expect(screen.getAllByLabelText(/Precio unitario/)[1]).toHaveValue('25.00');
    // Buscador del catálogo: no repite lo que ya está en la venta.
    await user.type(screen.getByLabelText(/Buscar producto o servicio/), 'amox');
    expect(await screen.findByRole('button', { name: 'Amoxicilina 500 mg ya está en la venta' })).toBeDisabled();
  });

  it('quien solo vende no ve la página del catálogo en el menú', async () => {
    mockApi(base(['apiworking:read', 'apiworking:sell', 'branch:read', 'clinic:read']) as never);
    renderApp('/');
    const nav = await screen.findByRole('navigation', { name: 'Principal' });
    await within(nav).findByRole('link', { name: 'Ventas' });
    expect(within(nav).queryByRole('link', { name: 'Catálogo' })).not.toBeInTheDocument();
  });
});
