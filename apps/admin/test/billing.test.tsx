import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach } from 'vitest';
import { CASHIER_PERMS, DENTIST_PERMS, mockApi, RECEPTION_PERMS, renderApp, sessionRoutes, SIM, STATUS_MOCK, STATUS_OFF } from './helpers';

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});
afterEach(() => vi.unstubAllGlobals());

const DOC = {
  id: 'doc-1', chargeId: 'ch-1', type: 'BOLETA', typeLabel: 'Boleta de venta (simulada)', number: 'BD01-00000007', status: 'ISSUED', statusLabel: 'Emitido',
  customer: { name: 'Camila Demo Nueva', docType: 'DNI', docNumber: '90000006' }, amountText: 'S/ 120.00', igvText: 'S/ 18.31', subtotalText: 'S/ 101.69',
  demoMark: 'DEMO — NO VÁLIDO PARA SUNAT', simulated: true, providerRef: 'DEMO-ABC123', rejectionReason: null, scenarioLabel: 'Emitido de inmediato', attempts: 1, issuedAt: '2026-10-20T15:00:00.000Z', createdAt: '2026-10-20T15:00:00.000Z',
  actions: { retry: false, reconcile: false, pdf: true },
};
const CHARGE = {
  id: 'ch-1', patient: { id: 'p-1', name: 'Camila Demo Nueva' }, appointmentId: 'ap-1', description: 'Consulta (demo)', amountCents: 12000, amountText: 'S/ 120.00',
  status: 'PAID', statusLabel: 'Pagado', paymentMethod: 'CASH', paymentMethodLabel: 'Efectivo', paidAt: '2026-10-20T14:50:00.000Z', createdAt: '2026-10-20T14:40:00.000Z', version: 2, document: null,
  actions: { pay: false, void: false, emitDocument: true },
};
const cashier = (extra: Record<string, never> = {}) => ({ ...sessionRoutes(CASHIER_PERMS, ['CASHIER']), 'GET /integrations/status': { json: STATUS_MOCK }, ...extra });

describe('Cobros, comprobantes y fidelización simulados', () => {
  it('en modo simulado muestra el aviso permanente y los módulos de Caja y Comprobantes', async () => {
    mockApi({ ...cashier(), 'GET /appointments': { json: [] }, 'GET /reviews/summary': { json: { simulation: SIM, average: 4.6, total: 128, requestsSent: 1, queued: 0, recent: [{ rating: 5, comment: 'Reseña de demostración (ficticia).', label: 'Paciente A (ficticio)' }] } } });
    renderApp('/');
    expect(await screen.findByRole('note')).toHaveTextContent('DEMO — NO VÁLIDO PARA SUNAT');
    expect(screen.getByRole('note')).toHaveTextContent(/SIMULACIÓN/);
    const nav = screen.getByRole('navigation', { name: 'Principal' });
    expect(within(nav).getAllByRole('link').map((l) => l.textContent)).toEqual(['Hoy', 'Agenda', 'Pacientes', 'Caja', 'Comprobantes']);
    expect(await screen.findByRole('heading', { name: 'Reseñas' })).toBeInTheDocument();
    expect(screen.getByText(/reseñas \(ficticias\)/)).toBeInTheDocument();
  });

  it('con las integraciones apagadas no hay aviso ni módulos de cobro', async () => {
    mockApi({ ...sessionRoutes(CASHIER_PERMS, ['CASHIER']), 'GET /integrations/status': { json: STATUS_OFF }, 'GET /appointments': { json: [] } });
    renderApp('/');
    await screen.findByRole('heading', { name: 'Hoy' });
    const nav = screen.getByRole('navigation', { name: 'Principal' });
    expect(within(nav).getAllByRole('link').map((l) => l.textContent)).toEqual(['Hoy', 'Agenda', 'Pacientes']);
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Reseñas' })).not.toBeInTheDocument();
  });

  it('emite un comprobante simulado eligiendo el escenario y muestra la marca DEMO', async () => {
    let issued = false;
    const { called } = mockApi({
      ...cashier(),
      'GET /billing/charges/ch-1': () => ({ json: { ...CHARGE, document: issued ? DOC : null } }),
      'POST /billing/charges/ch-1/document': () => { issued = true; return { status: 201, json: DOC }; },
    });
    renderApp('/caja/ch-1');
    const user = userEvent.setup();
    expect(await screen.findByRole('heading', { name: 'Cobro' })).toBeInTheDocument();
    expect(screen.getByText('S/ 120.00')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Escenario de simulación'), 'REJECT');
    await user.click(screen.getByRole('button', { name: 'Emitir comprobante simulado' }));
    await waitFor(() => expect(called('POST', '/billing/charges/ch-1/document')).toHaveLength(1));
    expect(called('POST', '/billing/charges/ch-1/document')[0]?.body).toEqual({ type: 'BOLETA', scenario: 'REJECT' });
    const mark = await screen.findAllByText('DEMO — NO VÁLIDO PARA SUNAT');
    expect(mark.length).toBeGreaterThan(0);
    expect(await screen.findByText('Emitido', { selector: '.badge' })).toBeInTheDocument();
    expect(screen.getByText('BD01-00000007', { exact: false })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Descargar PDF' }));
    await waitFor(() => expect(called('GET', '/billing/documents/doc-1/pdf')).toHaveLength(1));
  });

  it('la factura exige RUC de 11 dígitos y razón social antes de enviar', async () => {
    const { called } = mockApi({ ...cashier(), 'GET /billing/charges/ch-1': { json: CHARGE }, 'POST /billing/charges/ch-1/document': { status: 201, json: { ...DOC, type: 'FACTURA' } } });
    renderApp('/caja/ch-1');
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText('Tipo de comprobante'), 'FACTURA');
    await user.click(screen.getByRole('button', { name: 'Emitir comprobante simulado' }));
    expect(await screen.findByText('El RUC debe tener 11 dígitos.')).toBeInTheDocument();
    expect(called('POST', '/billing/charges/ch-1/document')).toHaveLength(0);
    await user.type(screen.getByLabelText('RUC del cliente (ficticio)'), '20000000001');
    await user.type(screen.getByLabelText('Razón social (ficticia)'), 'Empresa Demo SAC');
    await user.click(screen.getByRole('button', { name: 'Emitir comprobante simulado' }));
    await waitFor(() => expect(called('POST', '/billing/charges/ch-1/document')[0]?.body).toEqual({ type: 'FACTURA', scenario: 'ISSUE', customerRuc: '20000000001', customerName: 'Empresa Demo SAC' }));
  });

  it('error reintentable y requiere conciliación: ofrece reintentar y conciliar con explicación', async () => {
    const { called } = mockApi({
      ...cashier(),
      'GET /billing/charges/ch-1': { json: { ...CHARGE, actions: { pay: false, void: false, emitDocument: false }, document: { ...DOC, status: 'RETRYABLE_ERROR', statusLabel: 'Error reintentable', providerRef: null, issuedAt: null, actions: { retry: true, reconcile: true, pdf: true } } } },
      'POST /billing/documents/doc-1/retry': { json: DOC },
      'POST /billing/documents/doc-1/reconcile': { json: DOC },
    });
    renderApp('/caja/ch-1');
    const user = userEvent.setup();
    expect(await screen.findByText('Error reintentable', { selector: '.badge' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));
    await waitFor(() => expect(called('POST', '/billing/documents/doc-1/retry')).toHaveLength(1));
    expect(await screen.findByText('Reintento realizado.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Conciliar' }));
    await waitFor(() => expect(called('POST', '/billing/documents/doc-1/reconcile')).toHaveLength(1));
  });

  it('comprobantes: lista con la marca, cola y acciones de procesar y conciliar', async () => {
    const { called } = mockApi({
      ...cashier(),
      'GET /billing/documents': { json: [{ ...DOC, description: 'Consulta (demo)', patientName: 'Camila Demo' }] },
      'GET /billing/outbox': { json: [{ id: 'o-1', kind: 'LOYALTY_ACCRUE', kindLabel: 'Puntos de fidelización', status: 'SKIPPED', statusLabel: 'Omitido', attempts: 1, note: 'Sin autorización de fidelización del paciente', reference: 'Consulta (demo)', createdAt: '2026-10-20T15:00:00.000Z' }] },
      'POST /billing/outbox/process': { json: { processed: 1, done: 0, skipped: 1, retry: 0, failed: 0 } },
      'POST /billing/reconcile': { json: { checked: 0, results: {}, queue: {} } },
    });
    renderApp('/comprobantes');
    const user = userEvent.setup();
    expect(await screen.findByRole('heading', { name: 'Comprobantes' })).toBeInTheDocument();
    expect(await screen.findByText('BD01-00000007')).toBeInTheDocument();
    expect(screen.getAllByText(/DEMO — NO VÁLIDO PARA SUNAT/).length).toBeGreaterThanOrEqual(2); // banner + fila
    expect(await screen.findByText('Sin autorización de fidelización del paciente')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Procesar cola' }));
    expect(await screen.findByText(/Cola procesada: 1 mensaje/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Conciliar pendientes' }));
    await waitFor(() => expect(called('POST', '/billing/reconcile')).toHaveLength(1));
  });

  it('fidelización: con autorización muestra saldo, NFC y canje simulados; sin autorización, solo el aviso', async () => {
    const patient = { id: 'p-1', fullName: 'Camila Demo Nueva', firstName: 'Camila', lastName: 'Demo', status: 'ACTIVE', age: 31, isMinor: false, birthDate: null, identifiers: [{ type: 'DNI', number: '90000006' }], primaryMobile: '900000006' };
    const granted = {
      simulation: SIM, consent: 'GRANTED', rule: '1 punto por cada S/ 10 pagados (regla ficticia de demostración).',
      points: { balance: 12, accrued: 12, redeemed: 0, tier: 'Bronce (simulado)', recent: [{ kind: 'ACCRUAL', kindLabel: 'Acumulación', points: 12, reason: null, at: '2026-10-20T15:00:00.000Z' }] },
      nfc: { cardLabel: 'Tarjeta NFC DEMO ···AB12', status: 'Activa (simulada)', tapsLast30Days: 4, lastTapAt: '2026-10-18T15:00:00.000Z', tier: 'Bronce (simulado)' },
    };
    const { called } = mockApi({ ...cashier(), 'GET /patients/p-1': { json: patient }, 'GET /appointments': { json: [] }, 'GET /loyalty/patients/p-1': { json: granted }, 'POST /loyalty/patients/p-1/redeem': { json: { balance: 7 } } });
    const first = renderApp('/pacientes/p-1');
    const user = userEvent.setup();
    expect(await screen.findByRole('heading', { name: 'Fidelización' })).toBeInTheDocument();
    expect(await screen.findByText('Tarjeta NFC DEMO ···AB12')).toBeInTheDocument();
    expect(screen.getByText('Activa (simulada)')).toBeInTheDocument();
    expect(screen.getAllByText(/SIMULACIÓN/).length).toBeGreaterThan(1);
    await user.type(screen.getByLabelText('Canjear puntos'), '5');
    await user.click(screen.getByRole('button', { name: 'Canjear' }));
    await waitFor(() => expect(called('POST', '/loyalty/patients/p-1/redeem')).toHaveLength(1));
    expect(called('POST', '/loyalty/patients/p-1/redeem')[0]?.body).toMatchObject({ points: 5 });
    first.unmount();

    mockApi({ ...cashier(), 'GET /patients/p-1': { json: patient }, 'GET /appointments': { json: [] }, 'GET /loyalty/patients/p-1': { json: { simulation: SIM, consent: 'MISSING', message: 'El paciente no ha autorizado el programa de fidelización; no se muestran ni se acumulan puntos.' } } });
    renderApp('/pacientes/p-1');
    expect(await screen.findByText('Sin autorización de fidelización')).toBeInTheDocument();
    expect(screen.queryByLabelText('Canjear puntos')).not.toBeInTheDocument();
  });

  it('«Registrar cobro» aparece solo en citas atendidas, en modo simulado y con permiso de cobro', async () => {
    const appt = (over: object) => ({
      id: 'ap-1', branchId: 'b-1', status: 'ATTENDED', statusLabel: 'Atendido', startsAt: '2026-10-20T15:00:00.000Z', endsAt: '2026-10-20T15:30:00.000Z', date: '2026-10-20', time: '10:00', durationMinutes: 30,
      patient: { id: 'p-1', name: 'Camila Demo Nueva', mobile: null }, dentist: { userId: 'd-1', name: 'Valeria Demo' }, room: { id: 'r-1', name: 'Consultorio 1' }, service: { id: 's-1', name: 'Consulta (demo)', durationMinutes: 30 },
      notes: null, cancelReason: null, noShowReason: null, rescheduledCount: 0, version: 2, hasVisit: true,
      actions: { confirm: false, reschedule: false, cancel: false, noShow: false, editNotes: false, startAttention: false, openVisit: false }, ...over,
    });
    const cal = { from: '2026-10-20', to: '2026-10-20', dentists: [{ userId: 'd-1', name: 'Valeria Demo' }], rooms: [], windows: [{ dentistUserId: 'd-1', roomId: null, date: '2026-10-20', startsAt: '2026-10-20T13:00:00.000Z', endsAt: '2026-10-20T23:00:00.000Z' }], blocks: [], appointments: [{ id: 'ap-1', dentistUserId: 'd-1', roomId: 'r-1', startsAt: '2026-10-20T15:00:00.000Z', endsAt: '2026-10-20T15:30:00.000Z', status: 'ATTENDED', statusLabel: 'Atendido', service: 'Consulta (demo)', patient: { id: 'p-1', name: 'Camila Demo Nueva' } }] };
    const { called } = mockApi({ ...cashier(), 'GET /agenda/calendar': { json: cal }, 'GET /appointments/ap-1': { json: appt({}) }, 'POST /billing/charges': { status: 201, json: CHARGE }, 'GET /billing/charges/ch-1': { json: CHARGE } });
    const first = renderApp('/agenda');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Camila Demo Nueva/ }));
    await user.click(await screen.findByRole('button', { name: 'Registrar cobro' }));
    await waitFor(() => expect(called('POST', '/billing/charges')[0]?.body).toEqual({ patientId: 'p-1', appointmentId: 'ap-1' }));
    expect(await screen.findByRole('heading', { name: 'Cobro' })).toBeInTheDocument();
    first.unmount();
    // recepción sin permiso de caja, o con integraciones apagadas: no aparece
    mockApi({ ...sessionRoutes(DENTIST_PERMS, ['DENTIST']), 'GET /integrations/status': { json: STATUS_MOCK }, 'GET /agenda/calendar': { json: cal }, 'GET /appointments/ap-1': { json: appt({}) } });
    renderApp('/agenda');
    await userEvent.click(await screen.findByRole('button', { name: /Camila Demo Nueva/ }));
    await screen.findByRole('dialog', { name: 'Cita' });
    expect(screen.queryByRole('button', { name: 'Registrar cobro' })).not.toBeInTheDocument();
    expect(RECEPTION_PERMS).not.toContain('billing:manage');
  });
});
