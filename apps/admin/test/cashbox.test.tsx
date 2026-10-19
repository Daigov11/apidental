import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach } from 'vitest';
import { CASHIER_PERMS, mockApi, renderApp, sessionRoutes } from './helpers';

const PERMS = [...CASHIER_PERMS, 'cashbox:read', 'cashbox:write', 'cashbox:void', 'cashbox:close'];
const ACC = [
  { id: 'a-cash', name: 'Efectivo', kind: 'CASH', kindLabel: 'Efectivo', allowNegative: false, active: true },
  { id: 'a-yape', name: 'Yape / Plin', kind: 'YAPE_PLIN', kindLabel: 'Yape / Plin', allowNegative: false, active: true },
];
const CONFIG = { accounts: ACC, categories: [{ id: 'c-in', flow: 'INCOME', name: 'Cobro de atención', active: true }, { id: 'c-out', flow: 'EXPENSE', name: 'Insumos', active: true }], users: [{ id: 'u-1', name: 'Rosa Demo' }] };
const row = (a: (typeof ACC)[number], balanceCents: number, incomeCents = 0, expenseCents = 0) => ({ ...a, openingCents: 10000, incomeCents, expenseCents, balanceCents });
const SUMMARY = {
  branch: { id: 'b-1', name: 'Sede Demo' }, register: { id: 'r-1', name: 'Caja Sede Demo' }, lastClosedAt: null,
  session: { id: 's-1', openedAt: '2026-10-19T14:00:00.000Z', openedBy: 'Rosa Demo', openNotes: null },
  accounts: [row(ACC[0]!, 13000, 5000, 2000), row(ACC[1]!, 0)],
  totals: { openingCents: 20000, incomeCents: 5000, expenseCents: 2000, balanceCents: 13000 },
};
const MOV = { id: 'm-1', flow: 'INCOME', flowLabel: 'Ingreso', kind: 'NORMAL', kindLabel: '', description: 'Cobro de limpieza', operationNumber: null, amountCents: 5000, amountText: 'S/ 50.00', occurredAt: '2026-10-19T15:00:00.000Z', status: 'ACTIVE', voidReason: null, voidedBy: null, account: { id: 'a-cash', name: 'Efectivo', kind: 'CASH' }, category: { id: 'c-in', name: 'Cobro de atención' }, user: { id: 'u-1', name: 'Rosa Demo' } };

const routes = (extra: Record<string, unknown> = {}) => ({
  ...sessionRoutes(PERMS, ['CASHIER']), 'GET /cashbox/summary': { json: SUMMARY }, 'GET /cashbox/config': { json: CONFIG },
  'GET /cashbox/movements': { json: { items: [MOV], total: 1, incomeCents: 5000, expenseCents: 0 } }, ...extra,
});

beforeEach(() => { URL.createObjectURL = vi.fn(() => 'blob:x'); URL.revokeObjectURL = vi.fn(); vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {}); });
afterEach(() => vi.unstubAllGlobals());

// El contexto de prueba trae sede; la ruta se abre directamente.
describe('Caja chica', () => {
  it('muestra el saldo inicial, ingresos, egresos y saldo disponible, y el historial', async () => {
    mockApi(routes());
    renderApp('/caja-chica');
    const totals = await screen.findByLabelText('Resumen de la caja');
    expect(within(totals).getByText('Saldo inicial').parentElement).toHaveTextContent('S/ 200.00');
    expect(within(totals).getByText('Total de ingresos').parentElement).toHaveTextContent('S/ 50.00');
    expect(within(totals).getByText('Total de egresos').parentElement).toHaveTextContent('S/ 20.00');
    expect(within(totals).getByText('Saldo disponible').parentElement).toHaveTextContent('S/ 130.00');
    expect(await screen.findByText('Cobro de limpieza')).toBeInTheDocument();
  });

  it('el menú Acciones ofrece las cuatro opciones y registra un ingreso validando el monto', async () => {
    const { called } = mockApi(routes({ 'POST /cashbox/movements': { status: 201, json: MOV } }));
    renderApp('/caja-chica');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Acciones/ }));
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem').map((i) => i.textContent);
    expect(items).toEqual(expect.arrayContaining(['Nuevo ingreso', 'Nuevo egreso', 'Visualizar movimientos', 'Exportar PDF']));
    await user.click(screen.getByRole('menuitem', { name: 'Nuevo ingreso' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nuevo ingreso' });
    await user.click(within(dialog).getByRole('button', { name: 'Registrar ingreso' }));
    expect(await within(dialog).findByText(/Ingrese un monto mayor que cero/)).toBeInTheDocument();
    expect(called('POST', '/cashbox/movements')).toHaveLength(0);
    await user.type(within(dialog).getByLabelText('Descripción'), 'Cobro de limpieza');
    await user.selectOptions(within(dialog).getByLabelText('Tipo de operación'), 'c-in');
    await user.type(within(dialog).getByLabelText('Monto (S/)'), '50.5');
    await user.click(within(dialog).getByRole('button', { name: 'Registrar ingreso' }));
    await waitFor(() => expect(called('POST', '/cashbox/movements')).toHaveLength(1));
    const body = called('POST', '/cashbox/movements')[0]!.body as Record<string, unknown>;
    expect(body).toMatchObject({ flow: 'INCOME', accountId: 'a-cash', categoryId: 'c-in', amountCents: 5050, description: 'Cobro de limpieza' });
    expect(body['requestKey']).toMatch(/^[0-9a-f-]{36}$/);
    expect(body).not.toHaveProperty('occurredAt');
  });

  it('un egreso mayor al saldo de la cuenta se bloquea antes de enviar', async () => {
    const { called } = mockApi(routes());
    renderApp('/caja-chica');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Acciones/ }));
    await user.click(screen.getByRole('menuitem', { name: 'Nuevo egreso' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nuevo egreso' });
    await user.type(within(dialog).getByLabelText('Descripción'), 'Compra grande');
    await user.selectOptions(within(dialog).getByLabelText('Tipo de operación'), 'c-out');
    await user.type(within(dialog).getByLabelText('Monto (S/)'), '999');
    await user.click(within(dialog).getByRole('button', { name: 'Registrar egreso' }));
    expect(await within(dialog).findByText(/Supera el saldo disponible de Efectivo/)).toBeInTheDocument();
    expect(called('POST', '/cashbox/movements')).toHaveLength(0);
  });

  it('anula un movimiento pidiendo el motivo', async () => {
    const { called } = mockApi(routes({ 'POST /cashbox/movements/m-1/void': { json: { ...MOV, status: 'VOIDED' } } }));
    renderApp('/caja-chica');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Anular ingreso/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Anular movimiento' });
    await user.type(within(dialog).getByLabelText('Motivo'), 'Monto equivocado');
    await user.click(within(dialog).getByRole('button', { name: 'Anular movimiento' }));
    await waitFor(() => expect(called('POST', '/cashbox/movements/m-1/void')).toHaveLength(1));
    expect(called('POST', '/cashbox/movements/m-1/void')[0]!.body).toEqual({ reason: 'Monto equivocado' });
  });

  it('el cierre exige contar el efectivo y explicar la diferencia', async () => {
    const { called } = mockApi(routes({ 'POST /cashbox/close': { json: { id: 's-1', accounts: [] } } }));
    renderApp('/caja-chica');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Acciones/ }));
    await user.click(screen.getByRole('menuitem', { name: 'Cerrar caja' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cerrar caja' });
    await user.type(within(dialog).getByLabelText(/Efectivo: efectivo contado/), '120');
    expect(within(dialog).getByRole('status')).toHaveTextContent('Faltante de S/ 10.00');
    await user.click(within(dialog).getByRole('button', { name: 'Cerrar caja' }));
    expect(await within(dialog).findByText('Explique la diferencia.')).toBeInTheDocument();
    expect(called('POST', '/cashbox/close')).toHaveLength(0);
    await user.type(within(dialog).getByLabelText(/Notas del cierre/), 'Vuelto mal dado');
    await user.click(within(dialog).getByRole('button', { name: 'Cerrar caja' }));
    await waitFor(() => expect(called('POST', '/cashbox/close')).toHaveLength(1));
    expect(called('POST', '/cashbox/close')[0]!.body).toEqual({ counts: [{ accountId: 'a-cash', countedCents: 12000 }], notes: 'Vuelto mal dado' });
  });

  it('con la caja cerrada se ofrece abrirla y no se puede registrar', async () => {
    mockApi(routes({ 'GET /cashbox/summary': { json: { ...SUMMARY, session: null, lastClosedAt: '2026-10-18T23:00:00.000Z' } } }));
    renderApp('/caja-chica');
    const user = userEvent.setup();
    expect(await screen.findByText('La caja está cerrada')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Acciones/ }));
    expect(screen.getByRole('menuitem', { name: 'Nuevo ingreso' })).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: 'Abrir caja' })).toBeEnabled();
  });

  it('exporta el PDF por rango de fechas', async () => {
    const { fn } = mockApi(routes());
    renderApp('/caja-chica');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Acciones/ }));
    await user.click(screen.getByRole('menuitem', { name: 'Exportar PDF' }));
    const dialog = await screen.findByRole('dialog', { name: 'Exportar reporte en PDF' });
    await user.click(within(dialog).getByRole('button', { name: 'Descargar PDF' }));
    await waitFor(() => expect(fn.mock.calls.some((c) => String(c[0]).includes('/cashbox/report?from='))).toBe(true));
  });
});
