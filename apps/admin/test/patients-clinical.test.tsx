import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach } from 'vitest';
import { DENTIST_PERMS, mockApi, RECEPTION_PERMS, renderApp, sessionRoutes } from './helpers';

const PATIENT = { id: 'p-1', fullName: 'Lucía Demo Adulta', firstName: 'Lucía', lastName: 'Demo', status: 'ACTIVE', age: 38, isMinor: false, birthDate: '1988-04-12', identifiers: [{ type: 'DNI', number: '90000001' }], primaryMobile: '900000001' };
const DENIED = { status: 403, json: { message: 'Acceso denegado', statusCode: 403 } };

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:odonto');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});
afterEach(() => vi.unstubAllGlobals());

describe('Pacientes y acceso clínico', () => {
  it('busca pacientes por nombre y abre la ficha resumida (sin DNI ni nombres en la URL de búsqueda)', async () => {
    const { called } = mockApi({ ...sessionRoutes(RECEPTION_PERMS), 'GET /patients': { json: [PATIENT] }, 'GET /patients/p-1': { json: PATIENT }, 'GET /appointments': { json: [] } });
    renderApp('/pacientes');
    const user = userEvent.setup();
    expect(await screen.findByText('Busque a un paciente')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Buscar por DNI, nombre o celular'), 'Lucía');
    await user.click(screen.getByRole('button', { name: 'Buscar' }));
    const link = await screen.findByRole('link', { name: 'Lucía Demo Adulta' });
    expect(called('GET', '/patients')[0]?.query.get('name')).toBe('Lucía');
    expect(link.getAttribute('href')).toBe('/pacientes/p-1');
    await user.click(link);
    expect(await screen.findByRole('heading', { name: 'Lucía Demo Adulta' })).toBeInTheDocument();
    expect(screen.getByText(/DNI 90000001/, { selector: 'p' })).toBeInTheDocument();
    expect(await screen.findByText('Sin citas registradas')).toBeInTheDocument();
  });

  it('recepción: la ficha del paciente no muestra ni solicita nada clínico', async () => {
    const { calls } = mockApi({ ...sessionRoutes(RECEPTION_PERMS), 'GET /patients/p-1': { json: PATIENT }, 'GET /appointments': { json: [] } });
    renderApp('/pacientes/p-1');
    expect(await screen.findByText('Información clínica')).toBeInTheDocument();
    expect(screen.getByText(/solo están disponibles para el odontólogo que atiende al paciente/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Atención clínica' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /odontograma/i })).not.toBeInTheDocument();
    expect(calls.filter((c) => c.path.includes('/clinical'))).toHaveLength(0);
  });

  it('recepción: entrar por dirección directa a la ficha de atención o al odontograma muestra «Acceso denegado»', async () => {
    mockApi({
      ...sessionRoutes(RECEPTION_PERMS),
      'GET /patients/p-1/clinical/visits/v-1/sheet': DENIED,
      'GET /patients/p-1/clinical/odontogram': DENIED,
      'GET /clinical/odontogram/spec': DENIED,
    });
    const first = renderApp('/pacientes/p-1/atencion/v-1');
    expect(await screen.findByText('Acceso denegado')).toBeInTheDocument();
    expect(screen.getByText(/Su rol no incluye esta información/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reintentar' })).not.toBeInTheDocument();
    first.unmount();
    renderApp('/pacientes/p-1/odontograma');
    expect(await screen.findByText('Acceso denegado')).toBeInTheDocument();
  });

  it('odontólogo sin relación asistencial: avisa en lenguaje claro, sin mensajes técnicos', async () => {
    mockApi({
      ...sessionRoutes(DENTIST_PERMS, ['DENTIST']), 'GET /patients/p-1': { json: PATIENT }, 'GET /appointments': { json: [] },
      'GET /patients/p-1/clinical/visits': { status: 403, json: { message: 'Acceso denegado' } },
    });
    renderApp('/pacientes/p-1');
    expect(await screen.findByText('Sin acceso clínico a este paciente')).toBeInTheDocument();
    expect(screen.getByText(/relación asistencial vigente/)).toBeInTheDocument();
  });

  it('un error del servidor no muestra mensajes de infraestructura y ofrece reintentar', async () => {
    mockApi({ ...sessionRoutes(RECEPTION_PERMS), 'GET /patients/p-1': { status: 500, json: { message: 'PrismaClientKnownRequestError: connect ECONNREFUSED 10.0.0.5:3310', requestId: 'req-123' } } });
    renderApp('/pacientes/p-1');
    expect(await screen.findByText('No se pudo cargar')).toBeInTheDocument();
    expect(screen.getByText(/No pudimos completar la operación/)).toBeInTheDocument();
    expect(screen.getByText('Código de soporte: req-123')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Prisma|ECONNREFUSED|3310/);
    expect(screen.getByRole('button', { name: 'Reintentar' })).toBeInTheDocument();
  });

  it('odontólogo: ve el odontograma vigente en tabla, el dibujo y descarga el PDF', async () => {
    const { called } = mockApi({
      ...sessionRoutes(DENTIST_PERMS, ['DENTIST']),
      'GET /patients/p-1/clinical/odontogram': { json: {
        official: { version: 4, state: 'CORRECTED', stateLabel: 'Corregida', dentitionLabel: 'Dentición permanente', contentHidden: false, lastChange: { reason: null, at: '2026-10-15T08:00:00.000Z' },
          data: { teeth: { '16': { surfaces: { O: { state: 'CARIES' } } }, '36': { status: 'ABSENT' }, '46': { marks: ['CROWN'] } } }, formatNotice: 'Formato clínico por validar.' },
        draft: null, versionsCount: 4, formatNotice: 'Formato clínico por validar.' } },
      'GET /clinical/odontogram/spec': { json: {
        toothStatuses: [{ code: 'PRESENT', label: 'Presente' }, { code: 'ABSENT', label: 'Ausente' }], surfaces: [{ code: 'O', label: 'Oclusal / incisal' }],
        surfaceStates: [{ code: 'CARIES', label: 'Caries' }], marks: [{ code: 'CROWN', label: 'Corona' }],
        layout: { permanent: { upper: ['16', '26'], lower: ['36', '46'] }, primary: { upper: ['55', '65'], lower: ['75', '85'] } }, cell: { size: 36, polygons: {} } } },
      'GET /patients/p-1/clinical/odontogram/export': { json: {} },
    });
    renderApp('/pacientes/p-1/odontograma');
    expect(await screen.findByRole('heading', { name: 'Odontograma' })).toBeInTheDocument();
    expect(await screen.findByRole('group', { name: 'Odontograma, numeración FDI' })).toBeInTheDocument(); // el dibujo (solo lectura); la tabla siguiente tiene el mismo contenido
    const table = await screen.findByRole('table', { name: 'Piezas con hallazgos registrados' });
    expect(within(table).getByRole('rowheader', { name: 'Pieza 16' })).toBeInTheDocument();
    expect(await within(table).findByText('Oclusal / incisal: Caries')).toBeInTheDocument();
    expect(within(table).getByText('Ausente')).toBeInTheDocument();
    expect(within(table).getByText('Corona')).toBeInTheDocument();
    expect(screen.getAllByText(/Formato clínico por validar/).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: 'Descargar PDF' }));
    await waitFor(() => expect(called('GET', '/patients/p-1/clinical/odontogram/export').some((c) => c.query.get('format') === 'pdf')).toBe(true));
  });
});
