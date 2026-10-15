import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach } from 'vitest';
import { mockApi, renderApp, sessionRoutes, USER, CLINIC, RECEPTION_PERMS } from './helpers';

afterEach(() => vi.unstubAllGlobals());

describe('Inicio de sesión', () => {
  it('sin sesión muestra el formulario y entra al panel con contexto único; el token no se guarda en el navegador', async () => {
    const { called } = mockApi({
      ...sessionRoutes(RECEPTION_PERMS),
      'POST /auth/refresh': { status: 401, json: { message: 'No autenticado' } },
      'POST /auth/login': { json: { accessToken: 'tok-login', user: USER, contexts: [{ assignmentId: 'a-1', role: { code: 'RECEPTIONIST', name: 'Recepcionista' }, clinic: CLINIC, branch: { id: 'b-1', name: 'Sede Demo' } }] } },
      'POST /auth/select-context': { json: { accessToken: 'tok-ctx' } },
      'GET /appointments': { json: [] },
    });
    renderApp('/');
    const user = userEvent.setup();
    expect(await screen.findByRole('heading', { name: 'Ingrese a su clínica' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Correo'), 'recepcion.demo@apidental.test');
    await user.type(screen.getByLabelText('Contraseña'), 'Clave-Demo-Ficticia');
    await user.click(screen.getByRole('button', { name: 'Ingresar' }));
    expect(await screen.findByRole('heading', { name: 'Hoy' })).toBeInTheDocument();
    expect(screen.getByText(/Clínica Demo · Sede Demo/)).toBeInTheDocument();
    expect(called('POST', '/auth/login')[0]?.body).toEqual({ email: 'recepcion.demo@apidental.test', password: 'Clave-Demo-Ficticia' });
    expect(called('POST', '/auth/select-context')).toHaveLength(1);
    // el token de acceso solo vive en memoria
    const dump = (st: Storage) => JSON.stringify(Array.from({ length: st.length }, (_, i) => [st.key(i), st.getItem(st.key(i)!)]));
    expect(dump(localStorage)).not.toContain('tok-');
    expect(dump(sessionStorage)).not.toContain('tok-');
  });

  it('credenciales incorrectas: mensaje genérico que no revela si el correo existe', async () => {
    mockApi({ 'POST /auth/refresh': { status: 401, json: {} }, 'POST /auth/login': { status: 401, json: { message: 'Credenciales inválidas' } } });
    renderApp('/');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Correo'), 'alguien@clinica.pe');
    await user.type(screen.getByLabelText('Contraseña'), 'incorrecta-123');
    await user.click(screen.getByRole('button', { name: 'Ingresar' }));
    expect(await screen.findByText('Correo o contraseña incorrectos.')).toBeInTheDocument();
  });

  it('valida campos vacíos al enviar y no llama a la API', async () => {
    const { called } = mockApi({ 'POST /auth/refresh': { status: 401, json: {} } });
    renderApp('/');
    await userEvent.click(await screen.findByRole('button', { name: 'Ingresar' }));
    expect(await screen.findByText(/Escriba su correo/)).toBeInTheDocument();
    expect(called('POST', '/auth/login')).toHaveLength(0);
  });

  it('con más de un contexto pide elegir clínica y sede', async () => {
    mockApi({
      'POST /auth/refresh': { status: 401, json: {} },
      'POST /auth/login': { json: { accessToken: 't', user: USER, contexts: [
        { assignmentId: 'a-1', role: { code: 'RECEPTIONIST', name: 'Recepcionista' }, clinic: CLINIC, branch: { id: 'b-1', name: 'Sede Norte' } },
        { assignmentId: 'a-2', role: { code: 'DENTIST', name: 'Odontólogo' }, clinic: CLINIC, branch: { id: 'b-2', name: 'Sede Sur' } },
      ] } },
      'GET /auth/me': { json: { user: USER, context: null, roles: [], permissions: [] } },
    });
    renderApp('/');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Correo'), 'a@b.pe');
    await user.type(screen.getByLabelText('Contraseña'), 'x');
    await user.click(screen.getByRole('button', { name: 'Ingresar' }));
    expect(await screen.findByRole('heading', { name: '¿Dónde va a trabajar hoy?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Clínica Demo · Sede Norte/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Clínica Demo · Sede Sur/ })).toBeInTheDocument();
  });

  it('si ya hay una sesión (cookie), retoma sin pedir la contraseña', async () => {
    const { called } = mockApi({ ...sessionRoutes(RECEPTION_PERMS), 'GET /appointments': { json: [] } });
    renderApp('/');
    expect(await screen.findByRole('heading', { name: 'Hoy' })).toBeInTheDocument();
    await waitFor(() => expect(called('POST', '/auth/refresh')).toHaveLength(1));
    expect(called('POST', '/auth/refresh')[0]?.headers['x-requested-with']).toBe('ApiDental');
  });
});
