import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockApi, renderApp, sessionRoutes, USER } from './helpers';

const ADMIN = ['user:read', 'user:manage', 'assignment:manage', 'role:read', 'branch:read', 'clinic:read'];
const ROLES = [
  { code: 'RECEPTIONIST', name: 'Recepción', scope: 'CLINIC' },
  { code: 'DENTIST', name: 'Odontólogo', scope: 'CLINIC' },
  { code: 'CLINICAL_DIRECTOR', name: 'Director Clínico', scope: 'CLINIC' },
  { code: 'PLATFORM_ADMIN', name: 'Administrador de plataforma', scope: 'PLATFORM' },
];
const LOCAL = { id: 'u-2', email: 'ana@clinica.pe', firstName: 'Ana', lastName: 'Rojas', status: 'ACTIVE', lastLoginAt: null, createdAt: '2026-11-01T10:00:00.000Z', externalIdentity: null, assignments: [{ id: 'as-2', clinicId: 'c-1', branchId: null, status: 'ACTIVE', role: { code: 'DENTIST', name: 'Odontólogo' } }] };
const AW = { id: 'u-3', email: 'aw-201900000005@apiworking.invalid', firstName: 'Luis', lastName: 'Caja', status: 'ACTIVE', lastLoginAt: '2026-11-12T10:00:00.000Z', createdAt: '2026-11-12T10:00:00.000Z', externalIdentity: { externalUsername: 'luis.caja' }, assignments: [] };
const ME = { ...USER, status: 'ACTIVE', lastLoginAt: null, createdAt: '2026-11-01T10:00:00.000Z', externalIdentity: null, assignments: [{ id: 'as-1', clinicId: 'c-1', branchId: null, status: 'ACTIVE', role: { code: 'CLINIC_ADMIN', name: 'Administrador de clínica' } }] };

const routes = (perms = ADMIN, over: Record<string, unknown> = {}, mode: 'apiworking' | 'local' = 'apiworking') => ({
  ...sessionRoutes(perms, ['CLINIC_ADMIN']),
  'GET /appointments': { json: [] },
  'GET /integrations/status': { json: { mode: 'off', simulation: null } },
  'GET /auth/config': { json: { mode } },
  'GET /users': { json: [ME, LOCAL, AW] },
  'GET /roles': { json: ROLES },
  ...over,
});

describe('Usuarios', () => {
  it('el menú muestra Usuarios solo con user:read', async () => {
    mockApi(routes() as never);
    renderApp('/');
    expect(await within(await screen.findByRole('navigation', { name: 'Principal' })).findByRole('link', { name: 'Usuarios' })).toBeInTheDocument();
  });

  it('lista con quién ingresa cada uno; con Apiworking nadie restablece aquí (la contraseña es la de Apiworking)', async () => {
    const { called } = mockApi(routes() as never);
    renderApp('/usuarios');
    const aw = (await screen.findByText('luis.caja')).closest('tr')!;
    expect(within(aw).getByText('Sin rol: no puede operar')).toBeInTheDocument();
    expect(within(aw).queryByRole('button', { name: /Restablecer/ })).not.toBeInTheDocument();
    expect(within(aw).getByRole('button', { name: 'Asignar rol' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restablecer contraseña' })).not.toBeInTheDocument();
    // Sobre sí mismo no hay acciones.
    const self = screen.getByText(USER.email).closest('tr')!;
    expect(within(self).queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText(/usuario y contraseña de Apiworking/)).toBeInTheDocument();
    // El API acepta como máximo limit=100 (PaginationQuery).
    expect(Number(called('GET', '/users')[0]?.query.get('limit'))).toBeLessThanOrEqual(100);
  });

  it('crea el usuario en Apiworking (usuario obligatorio) y muestra la contraseña generada una sola vez', async () => {
    const { called } = mockApi(routes(ADMIN, { 'POST /users': { status: 201, json: { user: { id: 'u-9', email: 'aw-pending-nuevo.user@apiworking.invalid' }, username: 'nuevo.user', password: 'Abc23defGh' } } }) as never);
    renderApp('/usuarios');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Nuevo usuario' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nuevo usuario' });
    await user.type(within(dialog).getByLabelText('Nombres'), 'Nuevo');
    await user.type(within(dialog).getByLabelText('Apellidos'), 'Usuario');
    await user.type(within(dialog).getByLabelText(/Correo/), 'nuevo@clinica.pe');
    expect(within(dialog).getByRole('button', { name: 'Crear usuario' })).toBeDisabled(); // falta el usuario de Apiworking
    await user.type(within(dialog).getByLabelText('Usuario de Apiworking'), 'nuevo.user');
    // Ni el Director Clínico ni roles de plataforma se ofrecen.
    const roleSelect = within(dialog).getByLabelText('Rol');
    expect(within(roleSelect).queryByRole('option', { name: 'Director Clínico' })).not.toBeInTheDocument();
    expect(within(roleSelect).queryByRole('option', { name: 'Administrador de plataforma' })).not.toBeInTheDocument();
    await user.selectOptions(roleSelect, 'DENTIST');
    await user.click(within(dialog).getByRole('button', { name: 'Crear usuario' }));
    await waitFor(() => expect(called('POST', '/users')).toHaveLength(1));
    expect(called('POST', '/users')[0]?.body).toEqual({ firstName: 'Nuevo', lastName: 'Usuario', email: 'nuevo@clinica.pe', roleCode: 'DENTIST', username: 'nuevo.user' });
    const reveal = await screen.findByRole('dialog', { name: 'Usuario creado' });
    expect(within(reveal).getByText('Abc23defGh')).toBeInTheDocument();
    expect(within(reveal).getByText('nuevo.user')).toBeInTheDocument();
    await user.click(within(reveal).getByRole('button', { name: 'Ya la copié' }));
    expect(screen.queryByText('Abc23defGh')).not.toBeInTheDocument();
  });

  it('sin Apiworking (demos), restablece la contraseña escribiéndola (mínimo 6 caracteres)', async () => {
    const { called } = mockApi(routes(ADMIN, { 'POST /users/u-2/password': { json: { ok: true } } }, 'local') as never);
    renderApp('/usuarios');
    const user = userEvent.setup();
    const row = (await screen.findByText('ana@clinica.pe')).closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Restablecer contraseña' }));
    const dialog = await screen.findByRole('dialog', { name: 'Restablecer contraseña' });
    await user.selectOptions(within(dialog).getByLabelText('Contraseña'), 'typed');
    await user.type(within(dialog).getByLabelText(/Nueva contraseña/), 'abc12');
    expect(within(dialog).getByRole('button', { name: 'Restablecer' })).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/Nueva contraseña/), '3');
    await user.click(within(dialog).getByRole('button', { name: 'Restablecer' }));
    await waitFor(() => expect(called('POST', '/users/u-2/password')).toHaveLength(1));
    expect(called('POST', '/users/u-2/password')[0]?.body).toEqual({ password: 'abc123' });
    expect(await screen.findByText(/Contraseña cambiada/)).toBeInTheDocument();
  });

  it('asigna un rol a una cuenta de Apiworking sin rol', async () => {
    const { called } = mockApi(routes(ADMIN, { 'POST /assignments': { status: 201, json: { id: 'as-9' } } }) as never);
    renderApp('/usuarios');
    const user = userEvent.setup();
    const row = (await screen.findByText('luis.caja')).closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Asignar rol' }));
    const dialog = await screen.findByRole('dialog', { name: 'Asignar rol' });
    await user.selectOptions(within(dialog).getByLabelText('Rol'), 'RECEPTIONIST');
    await user.click(within(dialog).getByRole('button', { name: 'Asignar' }));
    await waitFor(() => expect(called('POST', '/assignments')).toHaveLength(1));
    expect(called('POST', '/assignments')[0]?.body).toEqual({ userId: 'u-3', roleCode: 'RECEPTIONIST' });
  });

  it('con solo user:read se ve la lista pero no se crea ni se modifica nada', async () => {
    mockApi(routes(['user:read', 'branch:read', 'clinic:read']) as never);
    renderApp('/usuarios');
    await screen.findByText('ana@clinica.pe');
    expect(screen.queryByRole('button', { name: 'Nuevo usuario' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restablecer contraseña' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Asignar rol' })).not.toBeInTheDocument();
  });
});
