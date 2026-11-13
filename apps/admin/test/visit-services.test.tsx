import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach } from 'vitest';
import { DENTIST_PERMS, mockApi, renderApp, sessionRoutes } from './helpers';

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });
const advanced = () => localStorage.setItem('apidental.ficha.vista', 'advanced');

const sheet = (status: 'OPEN' | 'CLOSED' = 'OPEN') => ({
  alerts: { advisory: true, items: [] },
  patient: { id: 'p-1', fullName: 'Marco Cuenta', age: 30, isMinor: false },
  allergyAssessment: { status: 'NOT_ASKED', label: 'Aún no se preguntó por alergias', activeAllergyCount: 0, version: 0 },
  consent: { state: 'GRANTED', label: 'Consentimiento registrado' },
  visit: { id: 'v-1', number: 1, status, statusLabel: status === 'OPEN' ? 'Abierta' : 'Cerrada', reason: null, startedAt: '2026-11-13T15:00:00.000Z', closedAt: null, version: 1 },
  diagnoses: [], procedures: [],
  odontogram: { savedVersion: null, hasDraft: false, formatNotice: 'Formato clínico por validar.' },
  evolution: null,
  actions: { readOnly: status !== 'OPEN', canAddDiagnosis: true, canAddProcedure: true, canWriteEvolution: true, canCloseEvolution: false, canCorrectEvolution: false, canCloseVisit: true, closeVisitBlockedBy: [] },
  notice: 'Los registros de esta ficha son declaraciones del profesional.',
});
const ITEMS = [{ id: 'vs-1', productId: 'pr-1', name: 'Curación', unitPriceCents: 10000, teeth: ['16', '26'], quantity: 2, subtotalCents: 20000, billed: false, createdAt: '2026-11-13T15:10:00.000Z' }];
const routes = (extra: Record<string, unknown> = {}, status: 'OPEN' | 'CLOSED' = 'OPEN') => ({
  ...sessionRoutes([...DENTIST_PERMS, 'procedure:read'], ['DENTIST']),
  'GET /patients/p-1/clinical/visits/v-1/sheet': { json: sheet(status) },
  'GET /patients/p-1': { json: { id: 'p-1', fullName: 'Marco Cuenta', identifiers: [{ type: 'DNI', number: '45678912' }], age: 30, isMinor: false } },
  'GET /patients/p-1/clinical/odontogram': { json: { official: null, draft: null, versionsCount: 0, formatNotice: 'Formato clínico por validar.' } },
  'GET /clinical/odontogram/spec': { json: { toothStatuses: [], surfaces: [], surfaceStates: [], marks: [] } },
  'GET /patients/p-1/clinical/visits/v-1/services': { json: { items: ITEMS, totalCents: 20000 } },
  'GET /products': { json: [{ id: 'pr-1', name: 'Curación', presentation: null, priceCents: 10000, kind: 'SERVICE', active: true }, { id: 'pr-2', name: 'Endodoncia', presentation: null, priceCents: 35000, kind: 'SERVICE', active: true }] },
  ...extra,
}) as Parameters<typeof mockApi>[0];

describe('Servicios realizados en la atención (vista avanzada, con piezas)', () => {
  beforeEach(advanced);
  it('muestra lo hecho con piezas, cantidad, subtotal y el total a pagar', async () => {
    mockApi(routes());
    renderApp('/pacientes/p-1/atencion/v-1');
    const card = (await screen.findByRole('heading', { name: 'Servicios realizados' })).closest('section')!;
    expect(await within(card).findByText('16, 26')).toBeInTheDocument();
    expect(within(card).getByText('Total a pagar')).toBeInTheDocument();
    expect(within(card).getAllByText('S/ 200.00').length).toBeGreaterThan(0);
  });

  it('agrega un servicio marcando las piezas: la cantidad es el número de piezas', async () => {
    const { called } = mockApi(routes({ 'POST /patients/p-1/clinical/visits/v-1/services': { status: 201, json: {} } }));
    renderApp('/pacientes/p-1/atencion/v-1');
    const user = userEvent.setup();
    const card = (await screen.findByRole('heading', { name: 'Servicios realizados' })).closest('section')!;
    await user.click(within(card).getByRole('button', { name: 'Agregar servicio' }));
    const dialog = await screen.findByRole('dialog', { name: 'Agregar servicio' });
    await user.selectOptions(await within(dialog).findByLabelText('Servicio'), 'pr-2');
    await user.click(within(dialog).getByRole('button', { name: 'Pieza 36' }));
    await user.click(within(dialog).getByRole('button', { name: 'Pieza 46' }));
    expect(within(dialog).getByRole('button', { name: 'Pieza 36' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(dialog).getByText('S/ 700.00')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Agregar' }));
    await waitFor(() => expect(called('POST', '/patients/p-1/clinical/visits/v-1/services')).toHaveLength(1));
    expect(called('POST', '/patients/p-1/clinical/visits/v-1/services')[0]?.body).toEqual({ productId: 'pr-2', teeth: ['36', '46'] });
  });

  it('sin piezas se indica la cantidad (servicio por vez) y se puede quitar lo agregado', async () => {
    const { called } = mockApi(routes({
      'POST /patients/p-1/clinical/visits/v-1/services': { status: 201, json: {} },
      'POST /patients/p-1/clinical/visits/v-1/services/vs-1/remove': { json: { ok: true } },
    }));
    renderApp('/pacientes/p-1/atencion/v-1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Quitar Curación' }));
    await waitFor(() => expect(called('POST', '/patients/p-1/clinical/visits/v-1/services/vs-1/remove')).toHaveLength(1));
    const card = screen.getByRole('heading', { name: 'Servicios realizados' }).closest('section')!;
    await user.click(within(card).getByRole('button', { name: 'Agregar servicio' }));
    const dialog = await screen.findByRole('dialog', { name: 'Agregar servicio' });
    await user.selectOptions(await within(dialog).findByLabelText('Servicio'), 'pr-1');
    await user.clear(within(dialog).getByLabelText('Cantidad'));
    await user.type(within(dialog).getByLabelText('Cantidad'), '2');
    await user.click(within(dialog).getByRole('button', { name: 'Agregar' }));
    await waitFor(() => expect(called('POST', '/patients/p-1/clinical/visits/v-1/services')).toHaveLength(1));
    expect(called('POST', '/patients/p-1/clinical/visits/v-1/services')[0]?.body).toEqual({ productId: 'pr-1', quantity: 2 });
  });

  it('con la consulta terminada no se agregan ni quitan servicios', async () => {
    mockApi(routes({}, 'CLOSED'));
    renderApp('/pacientes/p-1/atencion/v-1');
    const card = (await screen.findByRole('heading', { name: 'Servicios realizados' })).closest('section')!;
    await within(card).findByText('16, 26');
    expect(within(card).queryByRole('button', { name: 'Agregar servicio' })).not.toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: /Quitar/ })).not.toBeInTheDocument();
  });
});

describe('Servicios realizados en la vista sencilla (sin marcar dientes)', () => {
  it('un toque agrega el servicio; otro toque o «+» suma una pieza; con piezas marcadas no hay contador', async () => {
    let items = [...ITEMS];
    const { called } = mockApi(routes({
      'GET /patients/p-1/clinical/visits/v-1/services': () => ({ json: { items, totalCents: items.reduce((t, i) => t + i.subtotalCents, 0) } }),
      'POST /patients/p-1/clinical/visits/v-1/services': () => {
        items = [...items, { id: 'vs-2', productId: 'pr-2', name: 'Endodoncia', unitPriceCents: 35000, teeth: [], quantity: 1, subtotalCents: 35000, billed: false, createdAt: '2026-11-13T15:20:00.000Z' }];
        return { status: 201, json: items.at(-1) };
      },
      'POST /patients/p-1/clinical/visits/v-1/services/vs-2/quantity': (c: { body: unknown }) => {
        const q = (c.body as { quantity: number }).quantity;
        items = items.map((i) => (i.id === 'vs-2' ? { ...i, quantity: q, subtotalCents: 35000 * q } : i));
        return { json: items.at(-1) };
      },
    }));
    renderApp('/pacientes/p-1/atencion/v-1');
    const user = userEvent.setup();
    const card = (await screen.findByRole('heading', { name: 'Servicios realizados' })).closest('section')!;
    // La curación tiene piezas marcadas (desde la vista avanzada): se ve su cantidad, sin contador.
    expect(await within(card).findByText(/piezas 16, 26/)).toBeInTheDocument();
    expect(within(card).queryByRole('group', { name: 'Cantidad de Curación' })).not.toBeInTheDocument();

    await user.click(await within(card).findByRole('button', { name: /Endodoncia/ }));
    await waitFor(() => expect(called('POST', '/patients/p-1/clinical/visits/v-1/services')).toHaveLength(1));
    expect(called('POST', '/patients/p-1/clinical/visits/v-1/services')[0]?.body).toEqual({ productId: 'pr-2', quantity: 1 });

    const stepper = await within(card).findByRole('group', { name: 'Cantidad de Endodoncia' });
    await user.click(within(stepper).getByRole('button', { name: 'Una más de Endodoncia' }));
    await waitFor(() => expect(called('POST', '/patients/p-1/clinical/visits/v-1/services/vs-2/quantity')).toHaveLength(1));
    expect(called('POST', '/patients/p-1/clinical/visits/v-1/services/vs-2/quantity')[0]?.body).toEqual({ quantity: 2 });
    expect(await within(card).findByText('S/ 700.00')).toBeInTheDocument();
    expect(within(card).getByText('Total a cobrar')).toBeInTheDocument();
    expect(within(card).getAllByText('S/ 900.00').length).toBeGreaterThan(0);

    // Tocar de nuevo el mismo servicio también suma.
    await user.click(within(card).getByRole('button', { name: 'Endodoncia, S/ 350.00, 2 en la cuenta' }));
    await waitFor(() => expect(called('POST', '/patients/p-1/clinical/visits/v-1/services/vs-2/quantity')).toHaveLength(2));
    expect(called('POST', '/patients/p-1/clinical/visits/v-1/services/vs-2/quantity')[1]?.body).toEqual({ quantity: 3 });
  });

  it('con una sola pieza, «−» quita el servicio', async () => {
    const one = [{ ...ITEMS[0]!, id: 'vs-3', teeth: [], quantity: 1, subtotalCents: 10000 }];
    const { called } = mockApi(routes({
      'GET /patients/p-1/clinical/visits/v-1/services': { json: { items: one, totalCents: 10000 } },
      'POST /patients/p-1/clinical/visits/v-1/services/vs-3/remove': { json: { ok: true } },
    }));
    renderApp('/pacientes/p-1/atencion/v-1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Quitar Curación' }));
    await waitFor(() => expect(called('POST', '/patients/p-1/clinical/visits/v-1/services/vs-3/remove')).toHaveLength(1));
  });
});

describe('Otro servicio y receta desde la atención', () => {
  it('«Otro servicio»: nombre, precio y cantidad de algo que no está en el catálogo', async () => {
    const { called } = mockApi(routes({ 'POST /patients/p-1/clinical/visits/v-1/services': { status: 201, json: {} }, 'GET /patients/p-1/prescriptions': { json: [] } }));
    renderApp('/pacientes/p-1/atencion/v-1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Otro servicio' }));
    const dialog = await screen.findByRole('dialog', { name: 'Otro servicio' });
    await user.type(within(dialog).getByLabelText(/Nombre del servicio/), 'Retiro de puntos');
    await user.type(within(dialog).getByLabelText(/Precio/), '40');
    await user.clear(within(dialog).getByLabelText(/Cantidad/));
    await user.type(within(dialog).getByLabelText(/Cantidad/), '2');
    expect(within(dialog).getByText('S/ 80.00')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Agregar' }));
    await waitFor(() => expect(called('POST', '/patients/p-1/clinical/visits/v-1/services')).toHaveLength(1));
    expect(called('POST', '/patients/p-1/clinical/visits/v-1/services')[0]?.body).toEqual({ name: 'Retiro de puntos', unitPriceCents: 4000, quantity: 2 });
  });

  it('la receta se emite desde la atención (ligada a la visita) y se listan las de esta visita', async () => {
    const RX = { id: 'rx-1', number: 'RX-000007', patientId: 'p-1', visitId: 'v-1', prescriber: { id: 'u-1', name: 'Gina' }, diagnosis: null, notes: null, status: 'ACTIVE', lastEmailedAt: null, createdAt: '2026-11-13T15:30:00.000Z', items: [{ id: 'i1', position: 1, medication: 'Ibuprofeno 400 mg', dose: null, frequency: null, duration: null, instructions: null }] };
    const OTHER = { ...RX, id: 'rx-2', number: 'RX-000003', visitId: 'v-9' };
    mockApi(routes({ 'GET /patients/p-1/prescriptions': { json: [RX, OTHER] } }));
    renderApp('/pacientes/p-1/atencion/v-1');
    const user = userEvent.setup();
    const card = (await screen.findByRole('heading', { name: 'Receta' })).closest('section')!;
    expect(await within(card).findByText('RX-000007')).toBeInTheDocument();
    expect(within(card).queryByText('RX-000003')).not.toBeInTheDocument();
    expect(within(card).getByText(/el paciente decide si la compra/)).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Emitir receta' }));
    expect(await screen.findByRole('dialog', { name: 'Nueva receta' })).toBeInTheDocument();
  });
});
