import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach } from 'vitest';
import { DENTIST_PERMS, mockApi, renderApp, sessionRoutes } from './helpers';

afterEach(() => vi.unstubAllGlobals());

const sheet = (over: Record<string, unknown> = {}, actions: Record<string, unknown> = {}) => ({
  alerts: { advisory: true, items: [] },
  patient: { id: 'p-1', fullName: 'Ingrid Demo Pasaporte', age: 39, isMinor: false },
  allergyAssessment: { status: 'NOT_ASKED', label: 'Aún no se preguntó por alergias', activeAllergyCount: 0, version: 0 },
  consent: { state: 'MISSING', label: 'Falta el consentimiento clínico' },
  visit: { id: 'v-1', number: 1, status: 'OPEN', statusLabel: 'Abierta', reason: null, startedAt: '2026-10-15T23:07:00.000Z', closedAt: null, version: 1 },
  diagnoses: [], procedures: [],
  odontogram: { savedVersion: null, hasDraft: false, formatNotice: 'Formato clínico por validar.' },
  evolution: null,
  actions: { readOnly: false, canAddDiagnosis: true, canAddProcedure: true, canWriteEvolution: true, canCloseEvolution: false, canCorrectEvolution: false, canCloseVisit: true, closeVisitBlockedBy: [], ...actions },
  notice: 'Los registros de esta ficha son declaraciones del profesional.',
  ...over,
});
const routes = (s: unknown, extra: Record<string, unknown> = {}) => ({
  ...sessionRoutes([...DENTIST_PERMS, 'procedure:read'], ['DENTIST']),
  'GET /patients/p-1/clinical/visits/v-1/sheet': { json: s },
  'GET /patients/p-1': { json: { id: 'p-1', fullName: 'Ingrid Demo Pasaporte', identifiers: [{ type: 'PASSPORT', number: 'P1234567' }], age: 39, isMinor: false } },
  'GET /patients/p-1/clinical/odontogram': { json: { official: null, draft: null, versionsCount: 0, formatNotice: 'Formato clínico por validar.' } },
  'GET /clinical/odontogram/spec': { json: { toothStatuses: [], surfaces: [], surfaceStates: [], marks: [] } },
  ...extra,
}) as Parameters<typeof mockApi>[0];

describe('Ficha de atención editable', () => {
  it('el odontólogo responsable registra alergias, diagnóstico y procedimiento', async () => {
    const { called } = mockApi(routes(sheet(), {
      'PUT /patients/p-1/clinical/allergy-assessment': { json: {} },
      'POST /patients/p-1/clinical/visits/v-1/diagnoses': { status: 201, json: {} },
      'GET /procedure-definitions': { json: [{ id: 'def-1', code: 'LIMP', name: 'Limpieza dental', requiresClinicalConsent: false, status: 'ACTIVE' }] },
      'POST /patients/p-1/clinical/visits/v-1/procedures': { status: 201, json: {} },
    }));
    const user = userEvent.setup();
    renderApp('/pacientes/p-1/atencion/v-1');
    await user.click(await screen.findByRole('button', { name: 'Registrar evaluación' }));
    let dlg = await screen.findByRole('dialog', { name: 'Evaluación de alergias' });
    await user.click(within(dlg).getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(called('PUT', '/patients/p-1/clinical/allergy-assessment')).toHaveLength(1));
    expect(called('PUT', '/patients/p-1/clinical/allergy-assessment')[0]?.body).toMatchObject({ status: 'NO_KNOWN_ALLERGIES', source: 'PATIENT', expectedVersion: 0 });

    await user.click(screen.getByRole('button', { name: 'Agregar diagnóstico' }));
    dlg = await screen.findByRole('dialog', { name: 'Agregar diagnóstico' });
    await user.type(within(dlg).getByLabelText('Diagnóstico'), 'Caries en pieza 16');
    await user.click(within(dlg).getByRole('button', { name: 'Agregar' }));
    await waitFor(() => expect(called('POST', '/patients/p-1/clinical/visits/v-1/diagnoses')).toHaveLength(1));
    expect(called('POST', '/patients/p-1/clinical/visits/v-1/diagnoses')[0]?.body).toMatchObject({ description: 'Caries en pieza 16', certainty: 'PRESUMPTIVE' });

    await user.click(screen.getByRole('button', { name: 'Agregar procedimiento' }));
    dlg = await screen.findByRole('dialog', { name: 'Agregar procedimiento' });
    await user.selectOptions(await within(dlg).findByLabelText('Procedimiento'), 'def-1');
    await user.click(within(dlg).getByRole('button', { name: 'Agregar' }));
    await waitFor(() => expect(called('POST', '/patients/p-1/clinical/visits/v-1/procedures')).toHaveLength(1));
    expect(called('POST', '/patients/p-1/clinical/visits/v-1/procedures')[0]?.body).toMatchObject({ definitionId: 'def-1' });
  });

  it('guarda el borrador de la evolución y lo cierra con la contraseña', async () => {
    const draft = { state: 'DRAFT', stateLabel: 'Borrador', body: 'Control sin hallazgos', followUp: null, contentHidden: false, etag: '1.1' };
    let current = draft;
    const { called } = mockApi(routes(sheet({ evolution: draft }, { canCloseEvolution: true }), {
      'GET /patients/p-1/clinical/visits/v-1/sheet': () => ({ json: sheet({ evolution: current }, { canCloseEvolution: true }) }),
      'PUT /patients/p-1/clinical/visits/v-1/evolution': (c: { body: unknown }) => { current = { ...draft, body: (c.body as { body: string }).body, etag: '1.2' }; return { json: { evolution: current } }; },
      'POST /patients/p-1/clinical/visits/v-1/evolution/close': { json: {} },
    }));
    const user = userEvent.setup();
    renderApp('/pacientes/p-1/atencion/v-1');
    const box = await screen.findByLabelText('Evolución de la visita');
    await user.type(box, ' y limpieza');
    expect(screen.getByRole('button', { name: 'Cerrar evolución' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Guardar borrador' }));
    await waitFor(() => expect(called('PUT', '/patients/p-1/clinical/visits/v-1/evolution')).toHaveLength(1));
    expect(called('PUT', '/patients/p-1/clinical/visits/v-1/evolution')[0]?.body).toMatchObject({ body: 'Control sin hallazgos y limpieza', expectedEtag: '1.1' });
    await user.click(await screen.findByRole('button', { name: 'Cerrar evolución' }));
    const dlg = await screen.findByRole('dialog', { name: 'Cerrar la evolución' });
    await user.type(within(dlg).getByLabelText('Su contraseña'), 'secreta');
    await user.click(within(dlg).getByRole('button', { name: 'Cerrar evolución' }));
    await waitFor(() => expect(called('POST', '/patients/p-1/clinical/visits/v-1/evolution/close')).toHaveLength(1));
    expect(called('POST', '/patients/p-1/clinical/visits/v-1/evolution/close')[0]?.body).toMatchObject({ expectedEtag: '1.2', password: 'secreta' });
  });

  it('explica por qué no puede cerrar la visita y la cierra cuando no hay pendientes', async () => {
    mockApi(routes(sheet({}, { canCloseVisit: false, closeVisitBlockedBy: ['OPEN_PROCEDURES', 'OPEN_NOTE'] })));
    renderApp('/pacientes/p-1/atencion/v-1');
    expect(await screen.findByText(/procedimientos abiertos/)).toBeInTheDocument();
    expect(screen.getByText(/evolución está en borrador/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cerrar la visita' })).toBeDisabled();
  });

  it('cierra la visita cuando no hay pendientes', async () => {
    const { called } = mockApi(routes(sheet(), { 'POST /patients/p-1/clinical/visits/v-1/close': { json: {} } }));
    const user = userEvent.setup();
    renderApp('/pacientes/p-1/atencion/v-1');
    await user.click(await screen.findByRole('button', { name: 'Cerrar la visita' }));
    const dlg = await screen.findByRole('dialog', { name: 'Cerrar la visita' });
    await user.click(within(dlg).getByRole('button', { name: 'Cerrar visita' }));
    await waitFor(() => expect(called('POST', '/patients/p-1/clinical/visits/v-1/close')).toHaveLength(1));
    expect(called('POST', '/patients/p-1/clinical/visits/v-1/close')[0]?.body).toEqual({ expectedVersion: 1 });
  });

  it('es una sola vista: paciente, odontograma, hallazgos y nota de evolución; recepción de datos sin cobro para el odontólogo', async () => {
    mockApi(routes(sheet({
      diagnoses: [{ id: 'd-1', version: 1, description: 'Caries en pieza 16', certaintyLabel: 'Presuntivo', status: 'ACTIVE', statusLabel: 'Vigente' }],
      procedures: [{ id: 'pr-1', version: 1, name: 'Limpieza dental', notes: null, status: 'OPEN', statusLabel: 'Abierto', closeBlockedMessage: null, canClose: true }],
    })));
    renderApp('/pacientes/p-1/atencion/v-1');
    expect(await screen.findByRole('heading', { name: 'Ingrid Demo Pasaporte' })).toBeInTheDocument();
    expect(await screen.findByText('PASSPORT P1234567')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Odontograma' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Iniciar odontograma' })).toBeInTheDocument();
    const hall = screen.getByRole('region', { name: 'Hallazgos' });
    expect(within(hall).getByText('Caries en pieza 16')).toBeInTheDocument();
    expect(within(hall).getByRole('button', { name: 'Marcar realizado' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Nota de evolución' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Odontograma completo/ })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Cobros del paciente' })).not.toBeInTheDocument();
  });

  it('sin permiso de edición (solo lectura) no aparece ningún control de registro', async () => {
    mockApi(routes(sheet({ evolution: { state: 'CLOSED', stateLabel: 'Cerrada', body: 'Texto', followUp: null, contentHidden: false, etag: '1.1' } }, {
      readOnly: true, canAddDiagnosis: false, canAddProcedure: false, canWriteEvolution: false, canCloseVisit: false,
    })));
    renderApp('/pacientes/p-1/atencion/v-1');
    expect(await screen.findByText('Texto')).toBeInTheDocument();
    for (const name of [/Agregar/, 'Iniciar odontograma', 'Registrar evaluación', 'Guardar borrador', 'Cerrar la visita', 'Corregir evolución']) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
  });
});
