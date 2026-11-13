import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockApi, renderApp, sessionRoutes } from './helpers';

const ADMIN = ['agenda:manage', 'appointment:read', 'appointment:manage', 'branch:read', 'clinic:read'];
const GINA = { userId: 'd-1', name: 'Gina Paredes', specialties: [{ id: 's-1', name: 'Odontología general' }] };
const NUEVO = { userId: 'd-2', name: 'Luis Nuevo', specialties: [] };
const RULES = [{ id: 'r-1', branchId: 'b-1', dentistUserId: 'd-1', weekday: 1, weekdayLabel: 'Lunes', start: '09:00', end: '13:00', validFrom: '2026-01-01', validUntil: null }];

const routes = (over: Record<string, unknown> = {}) => ({
  ...sessionRoutes(ADMIN, ['CLINIC_ADMIN']),
  'GET /appointments': { json: [] },
  'GET /integrations/status': { json: { mode: 'off', simulation: null } },
  'GET /auth/config': { json: { mode: 'apiworking' } },
  'GET /agenda/dentists': { json: [GINA, NUEVO] },
  'GET /agenda/schedules': { json: RULES },
  'GET /agenda/specialties': { json: [{ id: 's-1', name: 'Odontología general', active: true }, { id: 's-2', name: 'Endodoncia', active: true }] },
  ...over,
});

describe('Horarios de odontólogos', () => {
  it('muestra el horario y las especialidades de cada odontólogo, y avisa a quien no tiene', async () => {
    mockApi(routes() as never);
    renderApp('/horarios');
    const gina = (await screen.findByRole('heading', { name: 'Gina Paredes' })).closest('section')!;
    expect(within(gina).getByText('Lunes')).toBeInTheDocument();
    expect(within(gina).getByText('13:00')).toBeInTheDocument();
    const luis = screen.getByRole('heading', { name: 'Luis Nuevo' }).closest('section')!;
    expect(within(luis).getByText(/Sin horario/)).toBeInTheDocument();
    expect(within(luis).getByText(/Sin especialidad/)).toBeInTheDocument();
  });

  it('agrega el mismo horario en varios días de una vez', async () => {
    const { called } = mockApi(routes({ 'POST /agenda/schedules': { status: 201, json: { id: 'new' } } }) as never);
    renderApp('/horarios');
    const user = userEvent.setup();
    const luis = (await screen.findByRole('heading', { name: 'Luis Nuevo' })).closest('section')!;
    await user.click(within(luis).getByRole('button', { name: 'Agregar horario' }));
    const dialog = await screen.findByRole('dialog', { name: 'Agregar horario · Luis Nuevo' });
    // Por defecto lunes a viernes; se quita el viernes y se agrega el sábado.
    await user.click(within(dialog).getByRole('checkbox', { name: 'Viernes' }));
    await user.click(within(dialog).getByRole('checkbox', { name: 'Sábado' }));
    await user.click(within(dialog).getByRole('button', { name: 'Agregar' }));
    await waitFor(() => expect(called('POST', '/agenda/schedules')).toHaveLength(5));
    expect(called('POST', '/agenda/schedules').map((c) => (c.body as { weekday: number }).weekday)).toEqual([1, 2, 3, 4, 6]);
    expect(called('POST', '/agenda/schedules')[0]?.body).toEqual({ branchId: 'b-1', dentistUserId: 'd-2', weekday: 1, start: '09:00', end: '18:00' });
    expect(await screen.findByText('5 horarios agregados.')).toBeInTheDocument();
  });

  it('quita un horario con motivo y guarda las especialidades', async () => {
    const { called } = mockApi(routes({ 'POST /agenda/schedules/r-1/deactivate': { json: { id: 'r-1', active: false } }, 'PUT /agenda/dentists/d-2/specialties': { json: {} } }) as never);
    renderApp('/horarios');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Quitar el horario del Lunes de 09:00 a 13:00' }));
    const dlg = await screen.findByRole('dialog', { name: 'Quitar horario' });
    await user.type(within(dlg).getByLabelText(/Motivo/), 'Ya no atiende');
    await user.click(within(dlg).getByRole('button', { name: 'Quitar' }));
    await waitFor(() => expect(called('POST', '/agenda/schedules/r-1/deactivate')).toHaveLength(1));

    const luis = screen.getByRole('heading', { name: 'Luis Nuevo' }).closest('section')!;
    await user.click(within(luis).getByRole('button', { name: 'Especialidades' }));
    const sp = await screen.findByRole('dialog', { name: 'Especialidades · Luis Nuevo' });
    await user.click(within(sp).getByRole('checkbox', { name: 'Endodoncia' }));
    await user.click(within(sp).getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(called('PUT', '/agenda/dentists/d-2/specialties')).toHaveLength(1));
    expect(called('PUT', '/agenda/dentists/d-2/specialties')[0]?.body).toEqual({ specialtyIds: ['s-2'] });
  });

  it('el menú muestra Horarios solo con agenda:manage', async () => {
    mockApi(routes() as never);
    renderApp('/');
    expect(await within(await screen.findByRole('navigation', { name: 'Principal' })).findByRole('link', { name: 'Horarios' })).toBeInTheDocument();
  });
});
