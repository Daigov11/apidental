import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach } from 'vitest';
import { DENTIST_PERMS, mockApi, renderApp, sessionRoutes } from './helpers';

const PATIENT = { id: 'p-1', fullName: 'Lucía Demo Adulta', firstName: 'Lucía', lastName: 'Demo', status: 'ACTIVE', age: 38, isMinor: false, birthDate: '1988-04-12', identifiers: [{ type: 'DNI', number: '90000001' }], primaryMobile: '900000001', primaryEmail: 'lucia@example.com' };
const RX = { id: 'r-1', number: 'RX-000001', patientId: 'p-1', visitId: null, prescriber: { id: 'u-1', name: 'Dra. Demo' }, diagnosis: null, notes: null, status: 'ACTIVE', lastEmailedAt: null, createdAt: '2026-10-19T15:00:00.000Z', items: [{ medication: 'Amoxicilina 500 mg', dose: '1 cápsula', frequency: 'Cada 8 horas', duration: '7 días', instructions: null }] };
const PERMS = [...DENTIST_PERMS, 'attachment:read'];

const base = () => ({
  ...sessionRoutes(PERMS, ['DENTIST']), 'GET /patients/p-1': { json: PATIENT }, 'GET /appointments': { json: [] },
  'GET /patients/p-1/clinical/visits': { json: [] }, 'GET /patients/p-1/attachments': { json: [] },
});

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:rx');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});
afterEach(() => vi.unstubAllGlobals());

describe('Recetas', () => {
  it('crea una receta desde la ficha del paciente, sin cita abierta', async () => {
    let created = false;
    const { called } = mockApi({
      ...base(),
      'GET /patients/p-1/prescriptions': () => ({ json: created ? [RX] : [] }),
      'POST /patients/p-1/prescriptions': () => { created = true; return { status: 201, json: RX }; },
    });
    renderApp('/pacientes/p-1');
    const user = userEvent.setup();
    expect(await screen.findByText('Todavía no hay recetas')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Nueva receta' }));
    const drawer = await screen.findByRole('dialog', { name: 'Nueva receta' });
    await user.click(within(drawer).getByRole('button', { name: 'Guardar receta' }));
    expect(await within(drawer).findAllByText(/Indique el medicamento|Agregue al menos/)).not.toHaveLength(0);
    expect(called('POST', '/patients/p-1/prescriptions')).toHaveLength(0);
    await user.type(within(drawer).getByLabelText('Medicamento y presentación'), 'Amoxicilina 500 mg');
    await user.type(within(drawer).getByLabelText(/Frecuencia/), 'Cada 8 horas');
    await user.click(within(drawer).getByRole('button', { name: 'Guardar receta' }));
    await waitFor(() => expect(called('POST', '/patients/p-1/prescriptions')).toHaveLength(1));
    const body = called('POST', '/patients/p-1/prescriptions')[0]!.body as { items: { medication: string; frequency: string }[]; visitId?: string };
    expect(body.items).toEqual([expect.objectContaining({ medication: 'Amoxicilina 500 mg', frequency: 'Cada 8 horas' })]);
    expect(body.visitId).toBeUndefined();
    expect(await screen.findByText(/RX-000001/)).toBeInTheDocument();
  });

  it('envía la receta al correo del paciente y avisa si el entorno es de desarrollo', async () => {
    const { called } = mockApi({
      ...base(),
      'GET /patients/p-1/prescriptions': { json: [RX] },
      'POST /patients/p-1/prescriptions/r-1/email': { json: { sent: true, to: 'lucia@example.com', simulated: true } },
    });
    renderApp('/pacientes/p-1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Enviar la receta RX-000001 por correo' }));
    const dialog = await screen.findByRole('dialog', { name: /Enviar receta RX-000001/ });
    expect(within(dialog).getByLabelText('Correo del paciente')).toHaveValue('lucia@example.com');
    await user.click(within(dialog).getByRole('button', { name: 'Enviar PDF' }));
    await waitFor(() => expect(called('POST', '/patients/p-1/prescriptions/r-1/email')).toHaveLength(1));
    expect(called('POST', '/patients/p-1/prescriptions/r-1/email')[0]!.body).toEqual({ to: 'lucia@example.com' });
    expect(await screen.findByText(/Modo de desarrollo/)).toBeInTheDocument();
  });

  it('elimina una receta pidiendo el motivo', async () => {
    const { called } = mockApi({
      ...base(),
      'GET /patients/p-1/prescriptions': { json: [RX] },
      'POST /patients/p-1/prescriptions/r-1/delete': { json: { ...RX, status: 'DELETED' } },
    });
    renderApp('/pacientes/p-1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Eliminar la receta RX-000001' }));
    const dialog = await screen.findByRole('dialog', { name: /Eliminar receta/ });
    await user.type(within(dialog).getByLabelText('Motivo'), 'Emitida por error');
    await user.click(within(dialog).getByRole('button', { name: 'Eliminar receta' }));
    await waitFor(() => expect(called('POST', '/patients/p-1/prescriptions/r-1/delete')).toHaveLength(1));
    expect(called('POST', '/patients/p-1/prescriptions/r-1/delete')[0]!.body).toEqual({ reason: 'Emitida por error' });
  });

  it('el módulo Recetas emite una receta eligiendo al paciente', async () => {
    const { called } = mockApi({
      ...sessionRoutes(DENTIST_PERMS, ['DENTIST']),
      'GET /prescriptions': { json: [{ ...RX, patientName: 'Lucía Demo Adulta' }] },
      'GET /patients': { json: [PATIENT] },
      'POST /patients/p-1/prescriptions': { status: 201, json: RX },
    });
    renderApp('/recetas');
    const user = userEvent.setup();
    expect(await screen.findByRole('link', { name: 'Lucía Demo Adulta' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Nueva receta' }));
    await user.type(await screen.findByLabelText('Buscar por DNI, nombre o celular'), 'Lucía');
    await user.click(await screen.findByRole('button', { name: /Lucía Demo Adulta/ }));
    const drawer = await screen.findByRole('dialog', { name: 'Nueva receta' });
    await user.type(within(drawer).getByLabelText('Medicamento y presentación'), 'Ibuprofeno 400 mg');
    await user.click(within(drawer).getByRole('button', { name: 'Guardar receta' }));
    await waitFor(() => expect(called('POST', '/patients/p-1/prescriptions')).toHaveLength(1));
  });
});

describe('Documentos y estudios', () => {
  it('lista los archivos clínicos y permite descargarlos', async () => {
    const A = { id: 'a-1', category: 'XRAY', originalName: 'panoramica.png', mimeType: 'image/png', sizeBytes: 2048, description: 'Inicial', status: 'ACTIVE', uploadedAt: '2026-10-19T15:00:00.000Z' };
    const { fn } = mockApi({ ...base(), 'GET /patients/p-1/prescriptions': { json: [] }, 'GET /patients/p-1/attachments': { json: [A] } });
    renderApp('/pacientes/p-1');
    const user = userEvent.setup();
    expect(await screen.findByText('panoramica.png')).toBeInTheDocument();
    expect(screen.getByText('Radiografía')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Adjuntar archivo' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Descargar panoramica.png' }));
    await waitFor(() => expect(fn.mock.calls.some((c) => String(c[0]).endsWith('/attachments/a-1/download'))).toBe(true));
  });
});
