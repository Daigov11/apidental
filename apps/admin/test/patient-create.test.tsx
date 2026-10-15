import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach } from 'vitest';
import { DENTIST_PERMS, mockApi, RECEPTION_PERMS, renderApp, sessionRoutes } from './helpers';

afterEach(() => vi.unstubAllGlobals());

const NEW = { id: 'p-9', fullName: 'Ana Quispe Rojas', firstName: 'Ana', lastName: 'Quispe', status: 'ACTIVE', age: 30, isMinor: false, birthDate: '1996-02-10', identifiers: [{ type: 'DNI', number: '71234567' }], primaryMobile: '987654321' };
const CLEAN = { json: { identifierConflict: null, possibleDuplicates: [] } };

describe('Alta de paciente', () => {
  it('Pacientes: sin resultados ofrece crear a la persona, con los datos ya escritos', async () => {
    const { called } = mockApi({
      ...sessionRoutes(RECEPTION_PERMS), 'GET /patients': { json: [] }, 'POST /patients/duplicate-check': CLEAN,
      'POST /patients': { status: 201, json: { patient: NEW, duplicateWarnings: [], warnings: ['CLINICAL_CONSENT_MISSING'] } }, 'GET /patients/p-9': { json: NEW }, 'GET /appointments': { json: [] },
    });
    renderApp('/pacientes');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Buscar por DNI, nombre o celular'), '71234567');
    await user.click(await screen.findByRole('button', { name: /Crear a «71234567»/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Nuevo paciente' });
    expect(within(dialog).getByLabelText(/Número/)).toHaveValue('71234567'); // el DNI buscado ya viene escrito
    await user.click(within(dialog).getByRole('button', { name: 'Crear paciente' }));
    expect(await within(dialog).findByText('Escriba los nombres.')).toBeInTheDocument(); // valida antes de enviar
    expect(called('POST', '/patients')).toHaveLength(0);
    await user.type(within(dialog).getByLabelText('Nombres'), 'Ana');
    await user.type(within(dialog).getByLabelText('Apellido paterno'), 'Quispe');
    await user.type(within(dialog).getByLabelText(/Celular/), '987654321');
    await user.click(within(dialog).getByRole('button', { name: 'Crear paciente' }));
    expect(await screen.findByRole('heading', { name: 'Ana Quispe Rojas' })).toBeInTheDocument(); // abre su ficha
    const sent = called('POST', '/patients')[0]!.body as Record<string, unknown>;
    const checked = called('POST', '/patients/duplicate-check')[0]!.body as Record<string, unknown>;
    expect(checked).toMatchObject({ firstName: 'Ana', lastName: 'Quispe', mobile: '987654321', identifier: { type: 'DNI', number: '71234567' } });
    expect(checked).not.toHaveProperty('contacts'); // la API rechaza campos desconocidos en la comprobación
    expect(sent).toMatchObject({ firstName: 'Ana', lastName: 'Quispe', identifier: { type: 'DNI', number: '71234567' }, contacts: [{ type: 'MOBILE', value: '987654321', isPrimary: true }] });
  });

  it('Pacientes: el botón «Nuevo paciente» existe solo para quien puede escribir', async () => {
    mockApi({ ...sessionRoutes(RECEPTION_PERMS) });
    const { unmount } = renderApp('/pacientes');
    expect(await screen.findByRole('button', { name: 'Nuevo paciente' })).toBeInTheDocument();
    unmount();
    mockApi({ ...sessionRoutes(DENTIST_PERMS, ['DENTIST']) });
    renderApp('/pacientes');
    expect(await screen.findByRole('heading', { name: 'Pacientes' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Nuevo paciente' })).not.toBeInTheDocument();
  });

  it('si el documento ya existe, no crea otra ficha y deja usar a la persona registrada', async () => {
    const { called } = mockApi({
      ...sessionRoutes(RECEPTION_PERMS), 'GET /patients': { json: [] },
      'POST /patients/duplicate-check': { json: { identifierConflict: { id: 'p-1', fullName: 'Lucía Demo Adulta' }, possibleDuplicates: [] } },
      'GET /patients/p-1': { json: { ...NEW, id: 'p-1', fullName: 'Lucía Demo Adulta' } }, 'GET /appointments': { json: [] },
    });
    renderApp('/pacientes');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Nuevo paciente' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nuevo paciente' });
    await user.type(within(dialog).getByLabelText(/Número/), '90000001');
    await user.type(within(dialog).getByLabelText('Nombres'), 'Lucia');
    await user.type(within(dialog).getByLabelText('Apellido paterno'), 'Demo');
    await user.click(within(dialog).getByRole('button', { name: 'Crear paciente' }));
    expect(await screen.findByText('Este paciente ya está registrado')).toBeInTheDocument();
    expect(called('POST', '/patients')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Usar a este paciente' }));
    expect(await screen.findByRole('heading', { name: 'Lucía Demo Adulta' })).toBeInTheDocument();
  });

  it('con coincidencias parecidas avisa y permite crear de todos modos', async () => {
    const { called } = mockApi({
      ...sessionRoutes(RECEPTION_PERMS), 'GET /patients': { json: [] },
      'POST /patients/duplicate-check': { json: { identifierConflict: null, possibleDuplicates: [{ patientId: 'p-4', fullName: 'Jorge Demo Repetido', birthDate: null, reasons: ['NAME'], confidence: 'MEDIUM' }] } },
      'POST /patients': { status: 201, json: { patient: NEW, duplicateWarnings: [], warnings: [] } }, 'GET /patients/p-9': { json: NEW }, 'GET /appointments': { json: [] },
    });
    renderApp('/pacientes');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Nuevo paciente' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nuevo paciente' });
    await user.type(within(dialog).getByLabelText('Nombres'), 'Jorge');
    await user.type(within(dialog).getByLabelText('Apellido paterno'), 'Demo');
    await user.click(within(dialog).getByRole('button', { name: 'Crear paciente' }));
    expect(await screen.findByText('Puede que ya exista')).toBeInTheDocument();
    expect(screen.getByText('mismo nombre')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Crear de todos modos' }));
    await waitFor(() => expect(called('POST', '/patients')).toHaveLength(1));
  });

  it('Nueva cita: si no encuentra al paciente ofrece crearlo ahí mismo y queda elegido', async () => {
    mockApi({
      ...sessionRoutes(RECEPTION_PERMS), 'GET /patients': { json: [] }, 'POST /patients/duplicate-check': CLEAN,
      'POST /patients': { status: 201, json: { patient: NEW, duplicateWarnings: [], warnings: [] } },
      'GET /agenda/calendar': { json: { from: '2026-10-20', to: '2026-10-20', dentists: [], rooms: [], windows: [], blocks: [], appointments: [] } },
      'GET /agenda/services': { json: [] },
    });
    renderApp('/agenda');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Nueva cita/ }));
    const drawer = await screen.findByRole('dialog', { name: 'Nueva cita' });
    await user.type(within(drawer).getByRole('combobox', { name: 'Paciente' }), 'Ana Quispe');
    await user.click(await within(drawer).findByRole('button', { name: 'Crear paciente nuevo' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nuevo paciente' });
    expect(within(dialog).getByLabelText('Nombres')).toHaveValue('Ana'); // lo escrito en la búsqueda
    expect(within(dialog).getByLabelText('Apellido paterno')).toHaveValue('Quispe');
    await user.click(within(dialog).getByRole('button', { name: 'Crear paciente' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Nuevo paciente' })).not.toBeInTheDocument());
    expect(within(screen.getByRole('dialog', { name: 'Nueva cita' })).getByRole('combobox', { name: 'Paciente' })).toHaveValue('Ana Quispe Rojas');
    expect(screen.getByText('Paciente elegido.')).toBeInTheDocument();
  });

  it('Pacientes: la lista aparece sin escribir y el filtro de estado pide inactivos', async () => {
    const { called } = mockApi({ ...sessionRoutes(RECEPTION_PERMS), 'GET /patients': { json: [NEW] } });
    renderApp('/pacientes');
    const user = userEvent.setup();
    expect(await screen.findByRole('link', { name: 'Ana Quispe Rojas' })).toBeInTheDocument();
    expect(called('GET', '/patients')[0]!.query.get('status')).toBe('ACTIVE');
    await user.selectOptions(screen.getByLabelText('Estado'), 'INACTIVE');
    await waitFor(() => expect(called('GET', '/patients').some((c) => c.query.get('status') === 'INACTIVE')).toBe(true));
  });

  it('Nueva cita: al enfocar el buscador ofrece pacientes sin escribir, y filtra desde 2 caracteres', async () => {
    const { called } = mockApi({
      ...sessionRoutes(RECEPTION_PERMS), 'GET /patients': { json: [NEW] },
      'GET /agenda/calendar': { json: { from: '2026-10-20', to: '2026-10-20', dentists: [], rooms: [], windows: [], blocks: [], appointments: [] } },
      'GET /agenda/services': { json: [] },
    });
    renderApp('/agenda');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Nueva cita/ }));
    const drawer = await screen.findByRole('dialog', { name: 'Nueva cita' });
    const box = within(drawer).getByRole('combobox', { name: 'Paciente' });
    await user.click(box);
    expect(await within(drawer).findByRole('option', { name: /Ana Quispe Rojas/ })).toBeInTheDocument();
    expect(called('GET', '/patients')[0]!.query.get('name')).toBeNull(); // sin filtro
    await user.type(box, 'An');
    await waitFor(() => expect(called('GET', '/patients').some((c) => c.query.get('name') === 'An')).toBe(true));
  });
});
