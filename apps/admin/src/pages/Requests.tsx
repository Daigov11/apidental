import { useState, type FormEvent } from 'react';
import { Inbox } from 'lucide-react';
import { post, get } from '../api/client';
import type { BookingRequest, BookingStatus, PatientSummary, Slot } from '../api/types';
import { useBranch } from '../lib/branch';
import { fmtDateTime, fmtShortDay, mobileFmt } from '../lib/format';
import { notifyRequestsChanged } from '../lib/bookingRequests';
import { useAsync } from '../lib/useAsync';
import { Button } from '../ui/Button';
import { SelectField, TextField } from '../ui/fields';
import { Alert, Badge, EmptyState, ErrorState, Loading, useToast } from '../ui/feedback';
import { Drawer, ReasonDialog } from '../ui/overlays';
import { explain } from './AppointmentPanels';
import { PatientPicker, SlotPicker } from './agenda-parts';
import type { PatientInitial } from './CreatePatientDialog';

type Filter = BookingStatus | 'ALL';
const TONE = { PENDING: 'warning', ACCEPTED: 'success', REJECTED: 'neutral' } as const;
const DOC_LABEL: Record<string, string> = { DNI: 'DNI', CE: 'Carné de extranjería', PASSPORT: 'Pasaporte' };
const fullName = (p: BookingRequest['person']) => [p.firstName, p.lastName, p.secondLastName].filter(Boolean).join(' ');

export function RequestsPage() {
  const toast = useToast();
  const [status, setStatus] = useState<Filter>('PENDING');
  const [attending, setAttending] = useState<BookingRequest | null>(null);
  const [rejecting, setRejecting] = useState<BookingRequest | null>(null);
  const list = useAsync(() => get<BookingRequest[]>('/booking-requests', { status, limit: 100 }), [status]);
  const refresh = () => { list.reload(); notifyRequestsChanged(); };

  return (
    <>
      <div className="page-head"><h1>Solicitudes de cita</h1></div>
      <p className="muted" style={{ marginBottom: 'var(--space-5)' }}>Pedidos que los pacientes hicieron desde la web. Atienda cada uno: elija al paciente, el odontólogo y el horario, y se reserva la cita.</p>
      <div className="toolbar">
        <SelectField label="Estado" value={status} onChange={(e) => setStatus(e.target.value as Filter)}>
          <option value="PENDING">Pendientes</option><option value="ACCEPTED">Aceptadas</option><option value="REJECTED">Rechazadas</option><option value="ALL">Todas</option>
        </SelectField>
      </div>
      <div aria-live="polite">
        {list.loading && !list.data && <Loading rows={3} label="Cargando solicitudes" />}
        {list.error != null && <ErrorState error={list.error} onRetry={list.reload} />}
        {list.data?.length === 0 && <EmptyState icon={<Inbox size={32} aria-hidden="true" />} title={status === 'PENDING' ? 'No hay solicitudes pendientes' : 'No hay solicitudes'}>Cuando un paciente pida una cita desde la web, aparecerá aquí.</EmptyState>}
        {list.data && list.data.length > 0 && (
          <div className="table-wrap table-cards">
            <table>
              <caption className="sr-only">Solicitudes de cita</caption>
              <thead><tr><th scope="col">Recibida</th><th scope="col">Paciente</th><th scope="col">Servicio</th><th scope="col">Horario pedido</th><th scope="col">Estado</th><th scope="col"><span className="sr-only">Acciones</span></th></tr></thead>
              <tbody>
                {list.data.map((r) => (
                  <tr key={r.id}>
                    <td data-label="Recibida" className="tabular">{fmtDateTime(r.createdAt)}</td>
                    <td data-label="Paciente"><strong>{fullName(r.person)}</strong><br /><span className="caption muted tabular">{mobileFmt(r.person.mobile)}</span></td>
                    <td data-label="Servicio">{r.service.name}<br /><span className="caption muted">{r.branch.name}</span></td>
                    <td data-label="Horario pedido" className="tabular">{fmtShortDay(r.date)} · {r.time}</td>
                    <td data-label="Estado"><Badge tone={TONE[r.status]}>{r.statusLabel}</Badge></td>
                    <td data-label="Acciones">
                      {r.status === 'PENDING'
                        ? <span className="row-actions"><Button size="sm" variant="primary" onClick={() => setAttending(r)}>Atender</Button><Button size="sm" onClick={() => setRejecting(r)}>Rechazar</Button></span>
                        : r.rejectReason ? <span className="caption muted">{r.rejectReason}</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {attending && <AttendDrawer request={attending} onClose={() => setAttending(null)} onDone={() => { setAttending(null); toast.success('Cita reservada a partir de la solicitud.'); refresh(); }} />}
      {rejecting && (
        <ReasonDialog
          title="Rechazar la solicitud" danger confirmLabel="Rechazar" example="No hay horarios para ese servicio"
          explain={`Se rechaza la solicitud de ${fullName(rejecting.person)}. Recepción debe avisarle por su cuenta.`}
          onClose={() => setRejecting(null)}
          onConfirm={async (reason) => { await post(`/booking-requests/${rejecting.id}/reject`, { reason }); setRejecting(null); toast.success('Solicitud rechazada.'); refresh(); }}
        />
      )}
    </>
  );
}

function AttendDrawer({ request: r, onClose, onDone }: { request: BookingRequest; onClose: () => void; onDone: () => void }) {
  const { branches } = useBranch();
  const dentists = useAsync(() => get<{ userId: string; name: string }[]>('/agenda/dentists', { branchId: r.branch.id }), [r.branch.id]);
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [dentistId, setDentistId] = useState('');
  const [date, setDate] = useState(r.date);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [preferredFree, setPreferredFree] = useState<boolean | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const p = r.person;
  const initial: PatientInitial = {
    firstName: p.firstName, lastName: p.lastName, secondLastName: p.secondLastName ?? undefined,
    docType: (p.documentType as PatientInitial['docType']) ?? undefined, docNumber: p.documentNumber ?? undefined, mobile: p.mobile, email: p.email ?? undefined,
  };
  const missing = { patient: !patient, dentist: !dentistId, slot: !slot };
  const sedeName = branches.find((b) => b.id === r.branch.id)?.name ?? r.branch.name;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (Object.values(missing).some(Boolean)) return;
    setBusy(true);
    setError(null);
    try {
      await post(`/booking-requests/${r.id}/accept`, { patientId: patient!.id, dentistUserId: dentistId, startsAt: slot!.startsAt });
      onDone();
    } catch (err) {
      setError(explain(err));
      setSlot(null);
      setReloadKey((k) => k + 1);
      setBusy(false);
    }
  };

  return (
    <Drawer
      title="Atender solicitud" onClose={onClose}
      footer={<><Button onClick={onClose}>Cancelar</Button><Button type="submit" form="attend-request" variant="primary" loading={busy} loadingText="Reservando…">Confirmar cita</Button></>}
    >
      <dl className="request-data">
        <div><dt>Paciente</dt><dd>{fullName(p)}</dd></div>
        <div><dt>Documento</dt><dd>{p.documentNumber ? `${DOC_LABEL[p.documentType ?? 'DNI'] ?? p.documentType} ${p.documentNumber}` : 'No indicó'}</dd></div>
        <div><dt>Celular</dt><dd className="tabular">{mobileFmt(p.mobile)}</dd></div>
        <div><dt>Correo</dt><dd>{p.email ?? 'No indicó'}</dd></div>
        <div><dt>Servicio</dt><dd>{r.service.name} · {r.service.durationMinutes} min</dd></div>
        <div><dt>Sede</dt><dd>{sedeName}</dd></div>
        <div><dt>Horario pedido</dt><dd className="tabular">{fmtShortDay(r.date)} · {r.time}</dd></div>
        {r.notes && <div><dt>Nota del paciente</dt><dd>{r.notes}</dd></div>}
      </dl>
      <p className="caption muted">La cita se reserva como «Reservado». Después, confírmela desde la agenda cuando hable con el paciente.</p>
      <form id="attend-request" onSubmit={(e) => void submit(e)} noValidate>
        {error && <Alert tone="danger">{error}</Alert>}
        <PatientPicker onPick={setPatient} createInitial={initial} initialText={p.documentNumber ?? `${p.firstName} ${p.lastName}`} error={submitted && missing.patient ? 'Elija o cree al paciente.' : null} />
        <SelectField label="Odontólogo" value={dentistId} onChange={(e) => { setDentistId(e.target.value); setSlot(null); setPreferredFree(null); }} error={submitted && missing.dentist ? 'Elija al odontólogo.' : null}>
          <option value="">Seleccione…</option>
          {dentists.data?.map((d) => <option key={d.userId} value={d.userId}>{d.name}</option>)}
        </SelectField>
        <TextField label="Fecha" type="date" value={date} onChange={(e) => { setDate(e.target.value); setSlot(null); setPreferredFree(null); }} />
        {dentistId && date === r.date && preferredFree === false && <Alert tone="warning">El horario pedido ({r.time}) ya no está libre con este odontólogo. Elija otro.</Alert>}
        <SlotPicker
          branchId={r.branch.id} serviceId={r.service.id} dentistUserId={dentistId} date={date} value={slot} onChange={setSlot} reloadKey={reloadKey}
          preferredStartsAt={date === r.date ? r.desiredStartsAt : undefined} onPreferredChecked={setPreferredFree}
        />
        {submitted && missing.slot && <p className="field-error" role="alert">Elija un horario disponible.</p>}
      </form>
    </Drawer>
  );
}
