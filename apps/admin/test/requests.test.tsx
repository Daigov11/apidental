import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach } from 'vitest';
import { CASHIER_PERMS, DENTIST_PERMS, mockApi, RECEPTION_PERMS, renderApp, sessionRoutes } from './helpers';

afterEach(() => vi.unstubAllGlobals());

const REQ = {
  id: 'r-1', reference: 'SOL-AB12CD', status: 'PENDING', statusLabel: 'Pendiente', createdAt: '2026-10-15T14:00:00.000Z',
  branch: { id: 'b-1', name: 'Sede Demo' }, service: { id: 's-1', name: 'Limpieza dental (demo)', durationMinutes: 30 },
  desiredStartsAt: '2026-10-20T15:00:00.000Z', date: '2026-10-20', time: '10:00',
  person: { firstName: 'Ana', lastName: 'Quispe', secondLastName: 'Rojas', documentType: 'DNI', documentNumber: '71234567', mobile: '987654321', email: 'ana@example.test' },
  notes: 'Prefiero por la mañana', appointmentId: null, patientId: null, rejectReason: null, decidedAt: null,
};
const SLOT = { date: '2026-10-20', time: '10:00', startsAt: '2026-10-20T15:00:00.000Z', dentistUserId: 'd-1', roomIds: ['room-1'] };
const SLOT_LATE = { ...SLOT, time: '11:00', startsAt: '2026-10-20T16:00:00.000Z' };
const PATIENT = { id: 'p-1', fullName: 'Ana Quispe Rojas', firstName: 'Ana', lastName: 'Quispe', status: 'ACTIVE', age: 30, isMinor: false, birthDate: null, identifiers: [{ type: 'DNI', number: '71234567' }], primaryMobile: '987654321' };

const base = (extra: Record<string, unknown> = {}) => ({
  ...sessionRoutes(RECEPTION_PERMS),
  'GET /booking-requests': { json: [REQ] }, 'GET /booking-requests/count': { json: { pending: 1 } },
  'GET /agenda/dentists': { json: [{ userId: 'd-1', name: 'Valeria Demo (odontóloga)', specialties: [] }] },
  'GET /agenda/availability': { json: { durationMinutes: 30, slots: [SLOT, SLOT_LATE] } },
  'GET /patients': { json: [PATIENT] }, 'GET /appointments': { json: [] },
  ...extra,
}) as Parameters<typeof mockApi>[0];

describe('Solicitudes de cita', () => {
  it('lista los pendientes y el menú muestra la insignia con su número', async () => {
    mockApi(base());
    renderApp('/solicitudes');
    expect(await screen.findByRole('heading', { name: 'Solicitudes de cita' })).toBeInTheDocument();
    const row = (await screen.findByText('Ana Quispe Rojas')).closest('tr')!;
    expect(within(row).getByText('Limpieza dental (demo)')).toBeInTheDocument();
    expect(within(row).getByText('Pendiente')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Atender' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Principal' });
    expect(within(nav).getByRole('link', { name: /Solicitudes/ })).toHaveTextContent('1 pendientes');
  });

  it('el filtro pide el estado elegido y sin solicitudes explica qué ocurrirá', async () => {
    const { called } = mockApi(base({ 'GET /booking-requests': (c: { query: URLSearchParams }) => ({ json: c.query.get('status') === 'PENDING' ? [REQ] : [] }) }));
    renderApp('/solicitudes');
    await screen.findByText('Ana Quispe Rojas');
    await userEvent.selectOptions(screen.getByLabelText('Estado'), 'ACCEPTED');
    expect(await screen.findByText('No hay solicitudes')).toBeInTheDocument();
    expect(called('GET', '/booking-requests').some((c) => c.query.get('status') === 'ACCEPTED')).toBe(true);
  });

  it('sin conteo disponible no hay insignia y sin permiso el ítem no existe', async () => {
    mockApi({ ...sessionRoutes(RECEPTION_PERMS), 'GET /booking-requests': { json: [] } }); // el conteo responde 404
    const { unmount } = renderApp('/solicitudes');
    const nav = await screen.findByRole('navigation', { name: 'Principal' });
    await screen.findByText('No hay solicitudes pendientes');
    expect(within(nav).getByRole('link', { name: 'Solicitudes' })).toBeInTheDocument();
    unmount();
    for (const perms of [DENTIST_PERMS, CASHIER_PERMS]) {
      mockApi({ ...sessionRoutes(perms, ['X']) });
      const r = renderApp('/');
      expect(await screen.findByRole('navigation', { name: 'Principal' })).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /Solicitudes/ })).not.toBeInTheDocument();
      r.unmount();
    }
  });

  it('atender con un paciente que ya existe: preselecciona el horario pedido y reserva la cita', async () => {
    const { called } = mockApi(base({ 'POST /booking-requests/r-1/accept': { status: 201, json: { id: 'ap-1' } } }));
    renderApp('/solicitudes');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Atender' }));
    const drawer = await screen.findByRole('dialog', { name: 'Atender solicitud' });
    expect(within(drawer).getByText('987 654 321')).toBeInTheDocument();
    expect(within(drawer).getByText('Prefiero por la mañana')).toBeInTheDocument();
    expect(within(drawer).getByText(/confírmela desde la agenda/)).toBeInTheDocument();
    await user.click(await within(drawer).findByRole('option', { name: /Ana Quispe Rojas/ })); // el buscador ya trae la coincidencia por documento
    await user.selectOptions(within(drawer).getByLabelText('Odontólogo'), 'd-1');
    await waitFor(() => expect(within(drawer).getByRole('radio', { name: '10:00' })).toBeChecked()); // horario pedido libre: elegido solo
    await user.click(within(drawer).getByRole('button', { name: 'Confirmar cita' }));
    await waitFor(() => expect(called('POST', '/booking-requests/r-1/accept')).toHaveLength(1));
    expect(called('POST', '/booking-requests/r-1/accept')[0]!.body).toEqual({ patientId: 'p-1', dentistUserId: 'd-1', startsAt: '2026-10-20T15:00:00.000Z' });
    expect(await screen.findByText('Cita reservada a partir de la solicitud.')).toBeInTheDocument();
  });

  it('si el horario pedido ya no está libre, avisa y deja elegir otro', async () => {
    mockApi(base({ 'GET /agenda/availability': { json: { durationMinutes: 30, slots: [SLOT_LATE] } } }));
    renderApp('/solicitudes');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Atender' }));
    const drawer = await screen.findByRole('dialog', { name: 'Atender solicitud' });
    await user.selectOptions(within(drawer).getByLabelText('Odontólogo'), 'd-1');
    expect(await within(drawer).findByText(/ya no está libre con este odontólogo/)).toBeInTheDocument();
    expect(within(drawer).getByRole('radio', { name: '11:00' })).not.toBeChecked();
  });

  it('atender creando al paciente: el formulario viene precargado con los datos de la solicitud', async () => {
    const { called } = mockApi(base({
      'GET /patients': { json: [] }, 'POST /patients/duplicate-check': { json: { identifierConflict: null, possibleDuplicates: [] } },
      'POST /patients': { status: 201, json: { patient: PATIENT, duplicateWarnings: [], warnings: [] } },
      'POST /booking-requests/r-1/accept': { status: 201, json: { id: 'ap-1' } },
    }));
    renderApp('/solicitudes');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Atender' }));
    const drawer = await screen.findByRole('dialog', { name: 'Atender solicitud' });
    await user.click(await within(drawer).findByRole('button', { name: 'Crear paciente nuevo' }));
    const form = await screen.findByRole('dialog', { name: 'Nuevo paciente' });
    expect(within(form).getByLabelText('Nombres')).toHaveValue('Ana');
    expect(within(form).getByLabelText('Apellido paterno')).toHaveValue('Quispe');
    expect(within(form).getByLabelText('Apellido materno (opcional)')).toHaveValue('Rojas');
    expect(within(form).getByLabelText(/Número/)).toHaveValue('71234567');
    expect(within(form).getByLabelText(/Celular/)).toHaveValue('987654321');
    expect(within(form).getByLabelText(/Correo/)).toHaveValue('ana@example.test');
    await user.click(within(form).getByRole('button', { name: 'Crear paciente' }));
    await waitFor(() => expect(called('POST', '/patients')).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Nuevo paciente' })).not.toBeInTheDocument());
    expect(within(screen.getByRole('dialog', { name: 'Atender solicitud' })).getByText('Paciente elegido.')).toBeInTheDocument();
  });

  it('un horario que se ocupó se explica en español y se puede elegir otro', async () => {
    mockApi(base({ 'POST /booking-requests/r-1/accept': { status: 409, json: { message: 'x', code: 'SLOT_TAKEN' } } }));
    renderApp('/solicitudes');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Atender' }));
    const drawer = await screen.findByRole('dialog', { name: 'Atender solicitud' });
    await user.click(await within(drawer).findByRole('option', { name: /Ana Quispe Rojas/ }));
    await user.selectOptions(within(drawer).getByLabelText('Odontólogo'), 'd-1');
    await waitFor(() => expect(within(drawer).getByRole('radio', { name: '10:00' })).toBeChecked());
    await user.click(within(drawer).getByRole('button', { name: 'Confirmar cita' }));
    expect(await within(drawer).findByText('Ese horario acaba de ocuparse. Elija otro.')).toBeInTheDocument();
  });

  it('rechazar pide el motivo y lo envía', async () => {
    const { called } = mockApi(base({ 'POST /booking-requests/r-1/reject': { json: { ...REQ, status: 'REJECTED' } } }));
    renderApp('/solicitudes');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Rechazar' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rechazar la solicitud' });
    await user.click(within(dialog).getByRole('button', { name: 'Rechazar' }));
    expect(await within(dialog).findByText('Escriba el motivo (al menos 3 caracteres).')).toBeInTheDocument();
    expect(called('POST', '/booking-requests/r-1/reject')).toHaveLength(0);
    await user.type(within(dialog).getByLabelText('Motivo'), 'No hay horarios para ese servicio');
    await user.click(within(dialog).getByRole('button', { name: 'Rechazar' }));
    await waitFor(() => expect(called('POST', '/booking-requests/r-1/reject')).toHaveLength(1));
    expect(called('POST', '/booking-requests/r-1/reject')[0]!.body).toEqual({ reason: 'No hay horarios para ese servicio' });
    expect(await screen.findByText('Solicitud rechazada.')).toBeInTheDocument();
  });
});
