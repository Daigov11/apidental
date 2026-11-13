import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach } from 'vitest';
import { mockApi, renderApp, sessionRoutes } from './helpers';

vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(async () => 'data:image/png;base64,QR') } }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const ADMIN = ['apiworking:read', 'apiworking:sell', 'apiworking:configure', 'branch:read', 'clinic:read'];
const base = (perms = ADMIN, over: Record<string, unknown> = {}) => ({
  ...sessionRoutes(perms, ['CLINIC_ADMIN']),
  'GET /appointments': { json: [] },
  'GET /integrations/status': { json: { mode: 'off', simulation: null } },
  'GET /auth/config': { json: { mode: 'apiworking' } },
  ...over,
}) as Parameters<typeof mockApi>[0];

describe('WhatsApp', () => {
  it('el administrador vincula el teléfono: muestra el QR y, al conectar, el número', async () => {
    let status = 'disconnected';
    const { called } = mockApi(base(ADMIN, {
      'GET /apiworking/whatsapp/status': () => ({ json: { phoneLabel: 'tiendaglowsmile_apiworking_co', status, statusLabel: status === 'connected' ? 'Conectado' : 'No vinculado', phoneNumber: status === 'connected' ? '+51999888777' : null, qr: null } }),
      'POST /apiworking/whatsapp/link': () => ({ json: { phoneLabel: 'tiendaglowsmile_apiworking_co', status: 'qr_pending', statusLabel: 'Esperando', phoneNumber: null, qr: '2@AbCdEf==' } }),
    }));
    renderApp('/whatsapp');
    const user = userEvent.setup();
    expect(await screen.findByText('No vinculado')).toBeInTheDocument();
    expect(screen.getByText('tiendaglowsmile_apiworking_co')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Vincular teléfono' }));
    expect(await screen.findByRole('img', { name: 'Código QR para vincular WhatsApp' })).toHaveAttribute('src', 'data:image/png;base64,QR');
    expect(called('POST', '/apiworking/whatsapp/link')).toHaveLength(1);
    // Escanean: el siguiente estado dice «connected» y el QR desaparece.
    status = 'connected';
    await waitFor(() => expect(screen.queryByRole('img', { name: /Código QR/ })).not.toBeInTheDocument(), { timeout: 5000 });
    expect(await screen.findByText('+51999888777')).toBeInTheDocument();
  });

  it('el menú muestra WhatsApp solo al administrador', async () => {
    mockApi(base(['apiworking:read', 'apiworking:sell', 'branch:read', 'clinic:read'], {}));
    renderApp('/');
    const nav = await screen.findByRole('navigation', { name: 'Principal' });
    await within(nav).findByRole('link', { name: 'Ventas' });
    expect(within(nav).queryByRole('link', { name: 'WhatsApp' })).not.toBeInTheDocument();
  });

  it('desde una cita: el borrador trae el celular y el texto, se edita y se envía', async () => {
    const APPT = {
      id: 'ap-1', branchId: 'b-1', status: 'CONFIRMED', statusLabel: 'Confirmado', startsAt: '2026-11-20T15:00:00.000Z', endsAt: '2026-11-20T15:30:00.000Z', date: '2026-11-20', time: '10:00', durationMinutes: 30,
      patient: { id: 'p-1', name: 'Lucía Cita', mobile: '987654321' }, dentist: { userId: 'd-1', name: 'Gina' }, room: { id: 'r-1', name: 'C1' }, service: { id: 's-1', name: 'Control', durationMinutes: 30 },
      notes: null, cancelReason: null, noShowReason: null, rescheduledCount: 0, version: 1, hasVisit: false,
      actions: { confirm: false, reschedule: true, cancel: true, noShow: false, editNotes: true, startAttention: false, openVisit: false },
    };
    const CAL = { from: '2026-11-20', to: '2026-11-20', dentists: [{ userId: 'd-1', name: 'Gina' }], rooms: [{ id: 'r-1', branchId: 'b-1', name: 'C1' }], windows: [], blocks: [], appointments: [{ id: 'ap-1', dentistUserId: 'd-1', roomId: 'r-1', startsAt: APPT.startsAt, endsAt: APPT.endsAt, status: 'CONFIRMED', statusLabel: 'Confirmado', service: 'Control', patient: { id: 'p-1', name: 'Lucía Cita' } }] };
    const { called } = mockApi(base([...ADMIN, 'appointment:read', 'appointment:manage'], {
      'GET /agenda/calendar': { json: CAL },
      'GET /appointments/ap-1': { json: APPT },
      'GET /apiworking/whatsapp/draft': { json: { phone: '987654321', text: 'Hola Lucía, le recordamos su cita.', context: 'appointment', refId: 'ap-1', hasLink: false } },
      'POST /apiworking/whatsapp/send': { json: { status: 'SENT', message: 'Mensaje enviado por WhatsApp', messageId: 'wamid.1' } },
    }));
    renderApp('/agenda?date=2026-11-20');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Lucía Cita/ }));
    await user.click(await screen.findByRole('button', { name: 'Enviar por WhatsApp' }));
    const dlg = await screen.findByRole('dialog', { name: 'Enviar por WhatsApp' });
    expect(await within(dlg).findByLabelText(/Celular/)).toHaveValue('987654321');
    await user.type(within(dlg).getByLabelText('Mensaje'), ' ¡Lo esperamos!');
    await user.click(within(dlg).getByRole('button', { name: 'Enviar' }));
    await waitFor(() => expect(called('POST', '/apiworking/whatsapp/send')).toHaveLength(1));
    expect(called('GET', '/apiworking/whatsapp/draft')[0]!.query.get('appointmentId')).toBe('ap-1');
    expect(called('POST', '/apiworking/whatsapp/send')[0]?.body).toEqual({ phone: '987654321', text: 'Hola Lucía, le recordamos su cita. ¡Lo esperamos!', context: 'appointment', refId: 'ap-1' });
    expect(await screen.findByText('Mensaje enviado por WhatsApp.')).toBeInTheDocument();
  });

  it('un envío no confirmado avisa y no deja reenviar desde el mismo diálogo', async () => {
    const SALE = { id: 's-1', description: 'Curación', customer: { name: 'MARCO', docType: 'DNI', docNumber: '1' }, totalCents: 1000, totalText: 'S/ 10.00', lines: [], docDate: '2026-11-13', serie: 'B001', docStatus: 'SENT', docStatusLabel: 'Registrado', paymentStatus: 'CONFIRMED_REMOTE', paymentStatusLabel: 'Pagado', voidStatus: null, voidStatusLabel: null, externalDocId: '1', externalNumber: 'B001-1', failureReason: null, attemptedAt: null, createdAt: '2026-11-13T15:00:00.000Z', actions: { issue: false, verify: false, reconcile: false, pay: false, void: false } };
    const { called } = mockApi(base(ADMIN, {
      'GET /apiworking/sales': { json: { items: [SALE], total: 1 } },
      'GET /apiworking/whatsapp/draft': { json: { phone: null, text: 'Su comprobante B001-1', context: 'sale', refId: 's-1', hasLink: true } },
      'POST /apiworking/whatsapp/send': { json: { status: 'UNCONFIRMED', message: 'No se pudo confirmar el envío: el mensaje pudo salir. Revise el chat antes de reenviar.' } },
    }));
    renderApp('/historial-ventas');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Enviar por WhatsApp B001-1' }));
    const dlg = await screen.findByRole('dialog', { name: 'Enviar por WhatsApp' });
    expect(await within(dlg).findByText(/No hay un celular registrado/)).toBeInTheDocument();
    await user.type(within(dlg).getByLabelText(/Celular/), '987654321');
    await user.click(within(dlg).getByRole('button', { name: 'Enviar' }));
    expect(await within(dlg).findByText(/Revise el chat antes de reenviar/)).toBeInTheDocument();
    expect(within(dlg).getByRole('button', { name: 'Enviar' })).toBeDisabled();
    expect(called('POST', '/apiworking/whatsapp/send')).toHaveLength(1);
  });
});
