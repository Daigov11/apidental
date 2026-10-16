import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach } from 'vitest';
import { DENTIST_PERMS, mockApi, RECEPTION_PERMS, renderApp, sessionRoutes } from './helpers';

afterEach(() => vi.unstubAllGlobals());

const DENTIST = { userId: 'd-1', name: 'Valeria Demo (odontóloga)' };
const APPT = {
  id: 'ap-1', branchId: 'b-1', status: 'RESERVED', statusLabel: 'Reservado', startsAt: '2026-10-20T15:00:00.000Z', endsAt: '2026-10-20T15:30:00.000Z',
  date: '2026-10-20', time: '10:00', durationMinutes: 30, patient: { id: 'p-1', name: 'Lucía Demo Adulta', mobile: '900000001' }, dentist: DENTIST,
  room: { id: 'r-1', name: 'Consultorio 1 (demo)' }, service: { id: 's-1', name: 'Control (demo)', durationMinutes: 20 }, notes: null, cancelReason: null, noShowReason: null,
  rescheduledCount: 0, version: 1, hasVisit: false,
  actions: { confirm: true, reschedule: true, cancel: true, noShow: false, editNotes: true, startAttention: false, openVisit: false },
};
const CALENDAR = {
  from: '2026-10-20', to: '2026-10-20', dentists: [DENTIST], rooms: [{ id: 'r-1', branchId: 'b-1', name: 'Consultorio 1 (demo)' }],
  windows: [{ dentistUserId: 'd-1', roomId: 'r-1', date: '2026-10-20', startsAt: '2026-10-20T13:00:00.000Z', endsAt: '2026-10-20T23:00:00.000Z' }],
  blocks: [], appointments: [{ id: 'ap-1', dentistUserId: 'd-1', roomId: 'r-1', startsAt: APPT.startsAt, endsAt: APPT.endsAt, status: 'RESERVED', statusLabel: 'Reservado', service: 'Control (demo)', patient: { id: 'p-1', name: 'Lucía Demo Adulta' } }],
};
const base = () => ({ ...sessionRoutes(RECEPTION_PERMS), 'GET /agenda/calendar': { json: CALENDAR }, 'GET /appointments/ap-1': { json: APPT } });

describe('Agenda', () => {
  it('muestra la agenda del día por odontólogo y solo los módulos permitidos', async () => {
    mockApi(base());
    renderApp('/agenda');
    expect(await screen.findByRole('heading', { name: 'Agenda' })).toBeInTheDocument();
    expect(await screen.findByText('Valeria Demo (odontóloga)', { selector: '.agenda-head' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '10:00, Lucía Demo Adulta, Control (demo), Reservado' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Principal' });
    expect(within(nav).getAllByRole('link').map((l) => l.textContent)).toEqual(['Hoy', 'Agenda', 'Solicitudes', 'Pacientes', 'Fotograma']);
    // el panel no muestra identificadores internos
    expect(document.body.textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
  });

  it('busca citas por nombre, documento o celular y abre la cita elegida', async () => {
    mockApi({
      ...base(),
      'GET /patients': { json: [{ id: 'p-1', fullName: 'Lucía Demo Adulta', status: 'ACTIVE' }] },
      'GET /appointments': { json: [APPT] },
    });
    renderApp('/agenda');
    await userEvent.type(await screen.findByLabelText('Buscar cita por documento, nombre o celular'), 'Lucía');
    await userEvent.click(await screen.findByRole('button', { name: 'Lucía Demo Adulta' }));
    await userEvent.click(await screen.findByRole('button', { name: /10:00 · Control \(demo\)/ }));
    expect(await screen.findByRole('dialog', { name: 'Cita' })).toBeInTheDocument();
  });

  it('abre la cita con sus acciones; recepción no ve «Iniciar atención»', async () => {
    mockApi(base());
    renderApp('/agenda');
    await userEvent.click(await screen.findByRole('button', { name: /10:00, Lucía Demo Adulta/ }));
    const drawer = await screen.findByRole('dialog', { name: 'Cita' });
    expect(within(drawer).getByText('Lucía Demo Adulta')).toBeInTheDocument();
    for (const name of ['Confirmar', 'Reprogramar', 'Cancelar cita']) expect(within(drawer).getByRole('button', { name })).toBeInTheDocument();
    expect(within(drawer).queryByRole('button', { name: 'Iniciar atención' })).not.toBeInTheDocument();
    expect(within(drawer).queryByRole('button', { name: /Abrir ficha de atención/ })).not.toBeInTheDocument();
  });

  it('crea una cita: busca al paciente, elige servicio, odontólogo y horario libre', async () => {
    const { called } = mockApi({
      ...base(),
      'GET /patients': { json: [{ id: 'p-1', fullName: 'Lucía Demo Adulta', identifiers: [{ type: 'DNI', number: '90000001' }], primaryMobile: '900000001', status: 'ACTIVE' }] },
      'GET /agenda/services': { json: [{ id: 's-1', name: 'Control (demo)', durationMinutes: 20, active: true }] },
      'GET /agenda/availability': { json: { durationMinutes: 20, slots: [{ date: '2026-10-20', time: '10:00', startsAt: '2026-10-20T15:00:00.000Z', dentistUserId: 'd-1', roomIds: ['r-1'] }, { date: '2026-10-20', time: '10:15', startsAt: '2026-10-20T15:15:00.000Z', dentistUserId: 'd-1', roomIds: ['r-1'] }] } },
      'POST /appointments': { status: 201, json: APPT },
    });
    renderApp('/agenda');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Nueva cita' }));
    const drawer = await screen.findByRole('dialog', { name: 'Nueva cita' });
    // enviar vacío muestra qué falta y no llama a la API
    await user.click(within(drawer).getByRole('button', { name: 'Reservar cita' }));
    expect(await within(drawer).findByText('Elija al paciente.')).toBeInTheDocument();
    expect(called('POST', '/appointments')).toHaveLength(0);

    await user.type(within(drawer).getByLabelText('Paciente'), 'Lucía');
    await user.click(await within(drawer).findByRole('option', { name: /Lucía Demo Adulta/ }));
    await user.selectOptions(within(drawer).getByLabelText('Servicio'), 's-1');
    await user.selectOptions(within(drawer).getByLabelText('Odontólogo'), 'd-1');
    await user.click(await within(drawer).findByRole('radio', { name: '10:15' }));
    await user.type(within(drawer).getByLabelText(/Notas administrativas/), 'Llega con su mamá');
    await user.click(within(drawer).getByRole('button', { name: 'Reservar cita' }));

    await waitFor(() => expect(called('POST', '/appointments')).toHaveLength(1));
    expect(called('POST', '/appointments')[0]?.body).toEqual({
      patientId: 'p-1', branchId: 'b-1', serviceId: 's-1', dentistUserId: 'd-1', startsAt: '2026-10-20T15:15:00.000Z', notes: 'Llega con su mamá',
    });
    expect(await screen.findByText('Cita reservada.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Nueva cita' })).not.toBeInTheDocument();
  });

  it('si el horario se ocupó mientras tanto, lo explica y conserva el panel abierto', async () => {
    mockApi({
      ...base(),
      'GET /patients': { json: [{ id: 'p-1', fullName: 'Lucía Demo Adulta', identifiers: [{ type: 'DNI', number: '90000001' }], primaryMobile: '900000001', status: 'ACTIVE' }] },
      'GET /agenda/services': { json: [{ id: 's-1', name: 'Control (demo)', durationMinutes: 20, active: true }] },
      'GET /agenda/availability': { json: { durationMinutes: 20, slots: [{ date: '2026-10-20', time: '10:00', startsAt: '2026-10-20T15:00:00.000Z', dentistUserId: 'd-1', roomIds: ['r-1'] }] } },
      'POST /appointments': { status: 409, json: { message: 'El horario ya está ocupado; elija otro', code: 'SLOT_TAKEN' } },
    });
    renderApp('/agenda');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Nueva cita' }));
    const drawer = await screen.findByRole('dialog', { name: 'Nueva cita' });
    await user.type(within(drawer).getByLabelText('Paciente'), 'Lucía');
    await user.click(await within(drawer).findByRole('option', { name: /Lucía Demo Adulta/ }));
    await user.selectOptions(within(drawer).getByLabelText('Servicio'), 's-1');
    await user.selectOptions(within(drawer).getByLabelText('Odontólogo'), 'd-1');
    await user.click(await within(drawer).findByRole('radio', { name: '10:00' }));
    await user.click(within(drawer).getByRole('button', { name: 'Reservar cita' }));
    expect(await within(drawer).findByText('Ese horario acaba de ocuparse. Elija otro.')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Nueva cita' })).toBeInTheDocument();
  });

  it('cancelar exige un motivo de al menos 3 caracteres y lo envía con la versión', async () => {
    const { called } = mockApi({ ...base(), 'POST /appointments/ap-1/cancel': { json: { ...APPT, status: 'CANCELLED', statusLabel: 'Cancelado' } } });
    renderApp('/agenda');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /10:00, Lucía Demo Adulta/ }));
    await user.click(await screen.findByRole('button', { name: 'Cancelar cita' }));
    const dlg = await screen.findByRole('dialog', { name: 'Cancelar la cita' });
    await user.type(within(dlg).getByLabelText('Motivo'), 'a');
    await user.click(within(dlg).getByRole('button', { name: 'Cancelar cita' }));
    expect(await within(dlg).findByText(/al menos 3 caracteres/)).toBeInTheDocument();
    expect(called('POST', '/appointments/ap-1/cancel')).toHaveLength(0);
    await user.clear(within(dlg).getByLabelText('Motivo'));
    await user.type(within(dlg).getByLabelText('Motivo'), 'El paciente avisó');
    await user.click(within(dlg).getByRole('button', { name: 'Cancelar cita' }));
    await waitFor(() => expect(called('POST', '/appointments/ap-1/cancel')).toHaveLength(1));
    expect(called('POST', '/appointments/ap-1/cancel')[0]?.body).toEqual({ expectedVersion: 1, reason: 'El paciente avisó' });
    expect(await screen.findByText('Cita cancelada.')).toBeInTheDocument();
  });

  it('el odontólogo inicia la atención de su cita y llega a la ficha de atención', async () => {
    const { called } = mockApi({
      ...sessionRoutes(DENTIST_PERMS, ['DENTIST']),
      'GET /agenda/calendar': { json: CALENDAR },
      'GET /appointments/ap-1': { json: { ...APPT, actions: { ...APPT.actions, confirm: false, reschedule: false, cancel: false, startAttention: true } } },
      'POST /appointments/ap-1/start-attention': { json: { appointment: { ...APPT, status: 'ATTENDED' }, visit: { id: 'v-1', number: 1, patientId: 'p-1' }, alreadyStarted: false } },
      'GET /patients/p-1/clinical/visits/v-1/sheet': {
        json: {
          alerts: { advisory: true, items: [{ id: 'al-1', origin: 'ALLERGY', severity: 'CRITICAL', label: 'Alergia a un material ficticio (demostración)' }] },
          patient: { id: 'p-1', fullName: 'Lucía Demo Adulta', age: 38, isMinor: false },
          allergyAssessment: { status: 'ALLERGIES_RECORDED', label: 'Tiene alergias registradas', activeAllergyCount: 1 },
          consent: { state: 'GRANTED', label: 'Consentimiento clínico vigente' },
          visit: { id: 'v-1', number: 1, status: 'OPEN', statusLabel: 'Abierta', reason: null, startedAt: '2026-10-20T15:00:00.000Z', closedAt: null },
          diagnoses: [], procedures: [], evolution: null, actions: { readOnly: false },
          odontogram: { savedVersion: null, hasDraft: false, formatNotice: 'Formato clínico por validar.' }, notice: 'Los registros de esta ficha son declaraciones del profesional.',
        },
      },
    });
    renderApp('/agenda');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /10:00, Lucía Demo Adulta/ }));
    await user.click(await screen.findByRole('button', { name: 'Iniciar atención' }));
    expect(await screen.findByRole('heading', { name: 'Ficha de atención' })).toBeInTheDocument();
    expect(called('POST', '/appointments/ap-1/start-attention')).toHaveLength(1);
    expect(screen.getByText(/Importante: Alergia a un material ficticio/)).toBeInTheDocument();
    expect(screen.getByText('Consentimiento clínico vigente')).toBeInTheDocument();
  });
});
