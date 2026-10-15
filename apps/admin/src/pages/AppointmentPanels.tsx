import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ClipboardList, Stethoscope } from 'lucide-react';
import { ApiError, get, post } from '../api/client';
import type { Appointment, PatientSummary, Slot } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { useIntegrations } from '../lib/integrations';
import type { Charge } from '../api/types';
import { fmtLongDay, timeOf, dayOf } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import { Button } from '../ui/Button';
import { SelectField, TextAreaField, TextField } from '../ui/fields';
import { Alert, ErrorState, Loading, StatusBadge, errorText, useToast } from '../ui/feedback';
import { Drawer, ReasonDialog } from '../ui/overlays';
import { PatientPicker, SlotPicker, useServices } from './agenda-parts';

const CODE_TEXT: Record<string, string> = {
  SLOT_TAKEN: 'Ese horario acaba de ocuparse. Elija otro.',
  PATIENT_BUSY: 'El paciente ya tiene una cita en ese horario.',
  OUTSIDE_SCHEDULE: 'El odontólogo no atiende en ese horario.',
  NO_ROOM: 'No hay consultorios libres en ese horario.',
  VERSION_CONFLICT: 'La cita cambió mientras la editaba. Se recargó; revise e intente de nuevo.',
  SERVICE_NOT_OFFERED: 'Ese odontólogo no atiende el servicio elegido.',
  INVALID_TRANSITION: 'La cita ya no admite este cambio.',
};
export const explain = (e: unknown): string => (e instanceof ApiError && e.code && CODE_TEXT[e.code]) || errorText(e);

export function NewAppointmentDrawer({
  branchId, dentists, defaultDate, defaultDentist, defaultPatient, onClose, onCreated,
}: {
  branchId: string; dentists: { userId: string; name: string }[]; defaultDate: string; defaultDentist?: string;
  defaultPatient?: PatientSummary; onClose: () => void; onCreated: () => void;
}) {
  const toast = useToast();
  const services = useServices();
  const [patient, setPatient] = useState<PatientSummary | null>(defaultPatient ?? null);
  const [serviceId, setServiceId] = useState('');
  const [dentistId, setDentistId] = useState(defaultDentist ?? '');
  const [date, setDate] = useState(defaultDate);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [notes, setNotes] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const missing = { patient: !patient, service: !serviceId, dentist: !dentistId, slot: !slot };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (Object.values(missing).some(Boolean)) return;
    setBusy(true);
    setError(null);
    try {
      await post('/appointments', { patientId: patient!.id, branchId, serviceId, dentistUserId: dentistId, startsAt: slot!.startsAt, notes: notes.trim() || undefined });
      toast.success('Cita reservada.');
      onCreated();
    } catch (err) {
      setError(explain(err));
      setSlot(null);
      setReloadKey((k) => k + 1);
      setBusy(false);
    }
  };

  return (
    <Drawer
      title="Nueva cita" onClose={onClose}
      footer={<><Button onClick={onClose}>Cancelar</Button><Button type="submit" form="new-appt" variant="primary" loading={busy} loadingText="Reservando…">Reservar cita</Button></>}
    >
      <form id="new-appt" onSubmit={submit} noValidate>
        {error && <Alert tone="danger">{error}</Alert>}
        {defaultPatient ? <p className="field"><span className="field-label">Paciente</span><span>{defaultPatient.fullName}</span></p> : <PatientPicker onPick={setPatient} error={submitted && missing.patient ? 'Elija al paciente.' : null} />}
        <SelectField label="Servicio" value={serviceId} onChange={(e) => { setServiceId(e.target.value); setSlot(null); }} error={submitted && missing.service ? 'Elija el servicio.' : null}>
          <option value="">Seleccione…</option>
          {services.data?.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.durationMinutes} min</option>)}
        </SelectField>
        <SelectField label="Odontólogo" value={dentistId} onChange={(e) => { setDentistId(e.target.value); setSlot(null); }} error={submitted && missing.dentist ? 'Elija al odontólogo.' : null}>
          <option value="">Seleccione…</option>
          {dentists.map((d) => <option key={d.userId} value={d.userId}>{d.name}</option>)}
        </SelectField>
        <TextField label="Fecha" type="date" value={date} onChange={(e) => { setDate(e.target.value); setSlot(null); }} />
        <SlotPicker branchId={branchId} serviceId={serviceId} dentistUserId={dentistId} date={date} value={slot} onChange={setSlot} reloadKey={reloadKey} />
        {submitted && missing.slot && <p className="field-error" role="alert">Elija un horario disponible.</p>}
        <TextAreaField label="Notas administrativas" optional help="Por ejemplo: «Llega con su mamá». No escriba datos clínicos." maxLength={300} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </form>
    </Drawer>
  );
}

export function AppointmentDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { can } = useAuth();
  const { mode } = useIntegrations();
  const navigate = useNavigate();
  const toast = useToast();
  const appt = useAsync(() => get<Appointment>(`/appointments/${id}`), [id]);
  const [dialog, setDialog] = useState<'cancel' | 'noShow' | null>(null);
  const [resched, setResched] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const a = appt.data;

  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try { await fn(); toast.success(ok); appt.reload(); onChanged(); }
    catch (e) { toast.error(explain(e)); appt.reload(); }
    finally { setBusy(null); }
  };

  const startAttention = async () => {
    setBusy('start');
    try {
      const r = await post<{ visit: { id: string; patientId: string } }>(`/appointments/${id}/start-attention`);
      onChanged();
      await navigate(`/pacientes/${r.visit.patientId}/atencion/${r.visit.id}`);
    } catch (e) {
      toast.error(e instanceof ApiError && e.code === 'TOO_EARLY' ? 'Aún es temprano: podrá iniciar la atención 30 minutos antes de la cita.' : explain(e));
      setBusy(null);
    }
  };

  const charge = async () => {
    setBusy('charge');
    try {
      const c = await post<Charge>('/billing/charges', { patientId: a!.patient.id, appointmentId: id });
      await navigate(`/caja/${c.id}`);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CHARGE_EXISTS') {
        const list = await get<Charge[]>('/billing/charges', { patientId: a!.patient.id, limit: 50 });
        const found = list.find((c) => c.appointmentId === id && c.status !== 'VOIDED');
        if (found) { await navigate(`/caja/${found.id}`); return; }
      }
      toast.error(explain(e));
      setBusy(null);
    }
  };

  if (resched && a) return <RescheduleDrawer appt={a} onClose={() => setResched(false)} onDone={() => { setResched(false); appt.reload(); onChanged(); }} />;

  return (
    <>
      <Drawer title="Cita" onClose={onClose}>
        {appt.loading && !a && <Loading label="Cargando la cita" />}
        {appt.error != null && <ErrorState error={appt.error} onRetry={appt.reload} />}
        {a && (
          <>
            <p style={{ marginBottom: 'var(--space-5)' }}><StatusBadge status={a.status} label={a.statusLabel} /></p>
            <dl className="facts">
              <dt>Paciente</dt><dd>{a.patient.name}</dd>
              <dt>Fecha</dt><dd>{fmtLongDay(dayOf(a.startsAt))}</dd>
              <dt>Hora</dt><dd className="tabular">{timeOf(a.startsAt)} – {timeOf(a.endsAt)}</dd>
              <dt>Servicio</dt><dd>{a.service.name}</dd>
              <dt>Odontólogo</dt><dd>{a.dentist.name}</dd>
              <dt>Consultorio</dt><dd>{a.room.name}</dd>
              {a.notes && (<><dt>Notas</dt><dd>{a.notes}</dd></>)}
              {a.cancelReason && (<><dt>Motivo de cancelación</dt><dd>{a.cancelReason}</dd></>)}
              {a.noShowReason && (<><dt>Motivo de ausencia</dt><dd>{a.noShowReason}</dd></>)}
              {a.rescheduledCount > 0 && (<><dt>Reprogramaciones</dt><dd>{a.rescheduledCount}</dd></>)}
            </dl>
            <div className="chip-row" style={{ marginTop: 'var(--space-7)' }}>
              {a.actions.startAttention && <Button variant="primary" icon={<Stethoscope size={18} aria-hidden="true" />} loading={busy === 'start'} loadingText="Abriendo…" onClick={() => void startAttention()}>Iniciar atención</Button>}
              {a.actions.openVisit && a.visitId && <Button variant="primary" icon={<ClipboardList size={18} aria-hidden="true" />} onClick={() => navigate(`/pacientes/${a.patient.id}/atencion/${a.visitId}`)}>Abrir ficha de atención</Button>}
              {a.actions.confirm && <Button variant="primary" loading={busy === 'confirm'} loadingText="Confirmando…" onClick={() => void run('confirm', () => post(`/appointments/${id}/confirm`, { expectedVersion: a.version }), 'Cita confirmada.')}>Confirmar</Button>}
              {a.actions.reschedule && <Button onClick={() => setResched(true)}>Reprogramar</Button>}
              {a.actions.noShow && <Button onClick={() => setDialog('noShow')}>Marcar ausencia</Button>}
              {a.actions.cancel && <Button variant="danger" onClick={() => setDialog('cancel')}>Cancelar cita</Button>}
              {mode === 'mock' && a.status === 'ATTENDED' && can('charge:manage') && <Button variant="primary" loading={busy === 'charge'} loadingText="Abriendo…" onClick={() => void charge()}>Registrar cobro</Button>}
              {can('patient:read_basic') && <Button variant="tertiary" onClick={() => navigate(`/pacientes/${a.patient.id}`)}>Ver paciente</Button>}
            </div>
          </>
        )}
      </Drawer>
      {dialog === 'cancel' && a && (
        <ReasonDialog title="Cancelar la cita" explain="La cita quedará cancelada y el horario se liberará. El registro se conserva." confirmLabel="Cancelar cita" danger onClose={() => setDialog(null)}
          onConfirm={async (reason) => { await post(`/appointments/${id}/cancel`, { expectedVersion: a.version, reason }); setDialog(null); toast.success('Cita cancelada.'); appt.reload(); onChanged(); }} />
      )}
      {dialog === 'noShow' && a && (
        <ReasonDialog title="Marcar ausencia" explain="El paciente no asistió. El horario se libera y el registro se conserva." confirmLabel="Marcar ausencia" danger onClose={() => setDialog(null)}
          onConfirm={async (reason) => { await post(`/appointments/${id}/no-show`, { expectedVersion: a.version, reason }); setDialog(null); toast.success('Ausencia registrada.'); appt.reload(); onChanged(); }} />
      )}
    </>
  );
}

function RescheduleDrawer({ appt, onClose, onDone }: { appt: Appointment; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [date, setDate] = useState(dayOf(appt.startsAt));
  const [slot, setSlot] = useState<Slot | null>(null);
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (!slot || reason.trim().length < 3) return;
    setBusy(true); setError(null);
    try {
      await post(`/appointments/${appt.id}/reschedule`, { expectedVersion: appt.version, startsAt: slot.startsAt, reason: reason.trim() });
      toast.success('Cita reprogramada.');
      onDone();
    } catch (err) {
      setError(explain(err)); setSlot(null); setReloadKey((k) => k + 1); setBusy(false);
    }
  };
  return (
    <Drawer title="Reprogramar cita" onClose={onClose}
      footer={<><Button onClick={onClose}>Volver</Button><Button type="submit" form="resched" variant="primary" loading={busy} loadingText="Guardando…">Reprogramar</Button></>}>
      <form id="resched" onSubmit={submit} noValidate>
        <p className="muted" style={{ marginBottom: 'var(--space-5)' }}>{appt.patient.name} · {appt.service.name} · {appt.dentist.name}</p>
        {error && <Alert tone="danger">{error}</Alert>}
        <TextField label="Nueva fecha" type="date" value={date} onChange={(e) => { setDate(e.target.value); setSlot(null); }} />
        <SlotPicker branchId={appt.branchId} serviceId={appt.service.id} dentistUserId={appt.dentist.userId} date={date} ignoreAppointmentId={appt.id} value={slot} onChange={setSlot} reloadKey={reloadKey} />
        {submitted && !slot && <p className="field-error" role="alert">Elija un horario disponible.</p>}
        <TextAreaField label="Motivo" help="Por ejemplo: «El paciente pidió otro horario»." maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} error={submitted && reason.trim().length < 3 ? 'Escriba el motivo (al menos 3 caracteres).' : null} />
      </form>
    </Drawer>
  );
}
