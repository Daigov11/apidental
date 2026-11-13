import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach } from 'vitest';
import { mockApi, renderApp, sessionRoutes } from './helpers';

beforeEach(() => { URL.createObjectURL = vi.fn(() => 'blob:x'); URL.revokeObjectURL = vi.fn(); });
afterEach(() => vi.unstubAllGlobals());

const SALE = {
  id: 's-1', description: 'Curaciones', customer: { name: 'MARCO CUENTA', docType: 'D.N.I.', docNumber: '45678912' }, totalCents: 22500, totalText: 'S/ 225.00',
  discountCents: 2500, payments: [{ idMetodoPago: '1', amountCents: 12500 }, { idMetodoPago: '6', amountCents: 10000 }],
  lines: [], docDate: '2026-11-13', serie: 'B001', docStatus: 'SENT', docStatusLabel: 'Registrado en Apiworking', paymentStatus: 'CONFIRMED_REMOTE', paymentStatusLabel: 'Pagado',
  voidStatus: null, voidStatusLabel: null, externalDocId: '1', externalNumber: 'B001-1423', failureReason: null, attemptedAt: null, createdAt: '2026-11-13T15:00:00.000Z',
  actions: { issue: false, verify: false, reconcile: false, pay: false, void: false },
};
const routes = (over: Record<string, unknown> = {}) => ({
  ...sessionRoutes(['apiworking:read', 'apiworking:sell', 'branch:read', 'clinic:read'], ['CASHIER']),
  'GET /appointments': { json: [] },
  'GET /integrations/status': { json: { mode: 'off', simulation: null } },
  'GET /auth/config': { json: { mode: 'apiworking' } },
  'GET /apiworking/sales': { json: { items: [SALE], total: 1 } },
  'GET /apiworking/sales/export': { json: {} },
  ...over,
}) as Parameters<typeof mockApi>[0];

describe('Historial de ventas', () => {
  it('lista las ventas del mes con descuento, medios y estado', async () => {
    const { called } = mockApi(routes());
    renderApp('/historial-ventas');
    expect(await screen.findByText('B001-1423')).toBeInTheDocument();
    expect(screen.getByText('S/ 25.00')).toBeInTheDocument();
    expect(screen.getByText('Pagado con 2 medios')).toBeInTheDocument();
    const q = called('GET', '/apiworking/sales')[0]!.query;
    expect(q.get('from')).toMatch(/^\d{4}-\d{2}-01$/);
    expect(q.get('to')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('filtra por fechas y texto, y exporta con esos filtros en Excel y PDF', async () => {
    const { called } = mockApi(routes());
    renderApp('/historial-ventas');
    const user = userEvent.setup();
    await screen.findByText('B001-1423');
    await user.clear(screen.getByLabelText('Desde'));
    await user.type(screen.getByLabelText('Desde'), '2026-11-01');
    await user.clear(screen.getByLabelText('Hasta'));
    await user.type(screen.getByLabelText('Hasta'), '2026-11-13');
    await user.type(screen.getByLabelText(/^Buscar/), 'marco');
    await user.click(screen.getByRole('button', { name: 'Filtrar' }));
    await waitFor(() => expect(called('GET', '/apiworking/sales').at(-1)!.query.get('search')).toBe('marco'));
    await user.click(screen.getByRole('button', { name: 'Exportar Excel' }));
    await waitFor(() => expect(called('GET', '/apiworking/sales/export')).toHaveLength(1));
    const x = called('GET', '/apiworking/sales/export')[0]!.query;
    expect([x.get('format'), x.get('from'), x.get('to'), x.get('search')]).toEqual(['xlsx', '2026-11-01', '2026-11-13', 'marco']);
    await user.click(screen.getByRole('button', { name: 'Exportar PDF' }));
    await waitFor(() => expect(called('GET', '/apiworking/sales/export')).toHaveLength(2));
    expect(called('GET', '/apiworking/sales/export')[1]!.query.get('format')).toBe('pdf');
  });

  it('el menú ofrece el historial a quien ve las ventas', async () => {
    mockApi(routes());
    renderApp('/');
    expect(await screen.findByRole('link', { name: 'Historial de ventas' })).toBeInTheDocument();
  });
});
