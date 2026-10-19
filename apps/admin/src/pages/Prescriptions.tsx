import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Download, Mail, Pencil, Plus, Trash2, X } from 'lucide-react';
import { get, post, put } from '../api/client';
import type { PatientSummary, Prescription, PrescriptionItem } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { downloadFile } from '../lib/download';
import { fmtDate } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import { Button } from '../ui/Button';
import { TextAreaField, TextField } from '../ui/fields';
import { EmptyState, ErrorState, Loading, errorText, useToast } from '../ui/feedback';
import { Dialog, Drawer, ReasonDialog } from '../ui/overlays';

type Draft = { medication: string; dose: string; frequency: string; duration: string; instructions: string };
const blank = (): Draft => ({ medication: '', dose: '', frequency: '', duration: '', instructions: '' });
const toDraft = (i: PrescriptionItem): Draft => ({ medication: i.medication, dose: i.dose ?? '', frequency: i.frequency ?? '', duration: i.duration ?? '', instructions: i.instructions ?? '' });
const summary = (r: Prescription) => r.items.map((i) => i.medication).join(', ');

/** Crear o editar una receta. Funciona sin cita abierta; `visitId` la vincula a una atención cuando se emite desde ella. */
export function PrescriptionDrawer({ patientId, patientName, existing, visitId, onClose, onSaved }: {
  patientId: string; patientName: string; existing?: Prescription; visitId?: string; onClose: () => void; onSaved: (r: Prescription) => void;
}) {
  const [items, setItems] = useState<Draft[]>(existing ? existing.items.map(toDraft) : [blank()]);
  const [diagnosis, setDiagnosis] = useState(existing?.diagnosis ?? '');
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (i: number, patch: Partial<Draft>) => setItems((l) => l.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    const filled = items.filter((i) => i.medication.trim() || i.dose || i.frequency || i.duration || i.instructions);
    if (filled.length === 0 || filled.some((i) => i.medication.trim().length < 2)) return;
    setBusy(true);
    setError(null);
    const body = { items: filled, diagnosis: diagnosis.trim(), notes: notes.trim(), ...(existing || !visitId ? {} : { visitId }) };
    try {
      const saved = existing ? await put<Prescription>(`/patients/${patientId}/prescriptions/${existing.id}`, body) : await post<Prescription>(`/patients/${patientId}/prescriptions`, body);
      onSaved(saved);
    } catch (err) { setError(errorText(err)); setBusy(false); }
  };
  return (
    <Drawer
      title={existing ? `Editar receta ${existing.number}` : 'Nueva receta'} width={640} onClose={onClose}
      footer={<><Button onClick={onClose}>Cancelar</Button><Button type="submit" form="rx-form" variant="primary" loading={busy} loadingText="Guardando…">{existing ? 'Guardar cambios' : 'Guardar receta'}</Button></>}
    >
      <form id="rx-form" onSubmit={(e) => void submit(e)} noValidate style={{ display: 'grid', gap: 'var(--space-5)' }}>
        <p className="muted">Paciente: <strong>{patientName}</strong></p>
        <TextField label="Diagnóstico" optional value={diagnosis} maxLength={300} onChange={(e) => setDiagnosis(e.target.value)} />
        {items.map((it, i) => (
          <fieldset key={i} className="card" style={{ display: 'grid', gap: 'var(--space-3)', margin: 0 }}>
            <legend className="h4">Medicamento {i + 1}</legend>
            <TextField label="Medicamento y presentación" value={it.medication} maxLength={200} placeholder="Ejemplo: Amoxicilina 500 mg" onChange={(e) => set(i, { medication: e.target.value })} error={touched && it.medication.trim().length < 2 && (items.length === 1 || it.medication || it.dose || it.frequency || it.duration || it.instructions) ? 'Indique el medicamento.' : null} />
            <div className="grid-2">
              <TextField label="Dosis" optional value={it.dose} maxLength={120} placeholder="1 cápsula" onChange={(e) => set(i, { dose: e.target.value })} />
              <TextField label="Frecuencia" optional value={it.frequency} maxLength={120} placeholder="Cada 8 horas" onChange={(e) => set(i, { frequency: e.target.value })} />
            </div>
            <TextField label="Duración" optional value={it.duration} maxLength={120} placeholder="7 días" onChange={(e) => set(i, { duration: e.target.value })} />
            <TextField label="Indicaciones" optional value={it.instructions} maxLength={300} onChange={(e) => set(i, { instructions: e.target.value })} />
            {items.length > 1 && <div><Button size="sm" variant="tertiary" icon={<X size={16} aria-hidden="true" />} onClick={() => setItems((l) => l.filter((_, k) => k !== i))}>Quitar medicamento {i + 1}</Button></div>}
          </fieldset>
        ))}
        {items.length < 20 && <div><Button icon={<Plus size={16} aria-hidden="true" />} onClick={() => setItems((l) => [...l, blank()])}>Agregar medicamento</Button></div>}
        <TextAreaField label="Indicaciones generales" optional value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} />
        {touched && items.every((i) => !i.medication.trim()) && <p className="field-error" role="alert">Agregue al menos un medicamento.</p>}
        {error && <p className="field-error" role="alert">{error}</p>}
      </form>
    </Drawer>
  );
}

/** Envío del PDF al correo. Si se deja vacío en el listado general, el servidor usa el correo principal del paciente. */
export function EmailPrescriptionDialog({ patientId, rx, defaultTo, onClose, onSent }: { patientId: string; rx: Prescription; defaultTo?: string | null; onClose: () => void; onSent: () => void }) {
  const toast = useToast();
  const [to, setTo] = useState(defaultTo ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ sent: boolean; to: string; simulated: boolean }>(`/patients/${patientId}/prescriptions/${rx.id}/email`, to.trim() ? { to: to.trim() } : {});
      if (r.simulated) toast.success(`Modo de desarrollo: la receta se registró como enviada a ${r.to}, pero no salió a un correo real.`);
      else toast.success(`Receta enviada a ${r.to}.`);
      onSent();
    } catch (err) { setError(errorText(err)); setBusy(false); }
  };
  return (
    <Dialog title={`Enviar receta ${rx.number} por correo`} onClose={onClose}
      footer={<><Button onClick={onClose}>Cancelar</Button><Button type="submit" form="rx-mail" variant="primary" icon={<Mail size={18} aria-hidden="true" />} loading={busy} loadingText="Enviando…">Enviar PDF</Button></>}>
      <form id="rx-mail" onSubmit={(e) => void submit(e)} noValidate style={{ display: 'grid', gap: 'var(--space-4)' }}>
        <p className="muted">Se enviará la receta en PDF como archivo adjunto.</p>
        <TextField label="Correo del paciente" type="email" autoComplete="off" value={to} maxLength={254} onChange={(e) => setTo(e.target.value)} help={defaultTo ? undefined : 'Si lo deja vacío se usa el correo registrado del paciente.'} />
        {error && <p className="field-error" role="alert">{error}</p>}
      </form>
    </Dialog>
  );
}

/** Acciones de una receta (PDF, correo, editar, eliminar) con sus diálogos. */
export function usePrescriptionActions({ reload, patientEmail }: { reload: () => void; patientEmail?: string | null }) {
  const { can } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<Prescription | null>(null);
  const [emailing, setEmailing] = useState<Prescription | null>(null);
  const [deleting, setDeleting] = useState<Prescription | null>(null);
  const pdf = async (r: Prescription) => {
    setBusy(r.id);
    try { await downloadFile(`/patients/${r.patientId}/prescriptions/${r.id}/pdf`, {}, `receta-${r.number}.pdf`); } catch (e) { toast.error(errorText(e)); } finally { setBusy(null); }
  };
  const write = can('clinical:write');
  const buttons = (r: Prescription) => (
    <span className="chip-row">
      <Button size="sm" icon={<Download size={16} aria-hidden="true" />} loading={busy === r.id} loadingText="Preparando…" aria-label={`Descargar PDF de la receta ${r.number}`} onClick={() => void pdf(r)}>PDF</Button>
      <Button size="sm" icon={<Mail size={16} aria-hidden="true" />} aria-label={`Enviar la receta ${r.number} por correo`} onClick={() => setEmailing(r)}>Enviar</Button>
      {write && <Button size="sm" icon={<Pencil size={16} aria-hidden="true" />} aria-label={`Editar la receta ${r.number}`} onClick={() => setEditing(r)}>Editar</Button>}
      {write && <Button size="sm" variant="tertiary" icon={<Trash2 size={16} aria-hidden="true" />} aria-label={`Eliminar la receta ${r.number}`} onClick={() => setDeleting(r)}>Eliminar</Button>}
    </span>
  );
  const dialogs = (patientName: (r: Prescription) => string) => (
    <>
      {editing && <PrescriptionDrawer patientId={editing.patientId} patientName={patientName(editing)} existing={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); toast.success('Receta actualizada.'); reload(); }} />}
      {emailing && <EmailPrescriptionDialog patientId={emailing.patientId} rx={emailing} defaultTo={patientEmail} onClose={() => setEmailing(null)} onSent={() => { setEmailing(null); reload(); }} />}
      {deleting && (
        <ReasonDialog title={`Eliminar receta ${deleting.number}`} danger confirmLabel="Eliminar receta" example="Se emitió al paciente equivocado"
          explain="La receta dejará de mostrarse y no podrá descargarse ni enviarse. El registro se conserva para auditoría."
          onClose={() => setDeleting(null)}
          onConfirm={async (reason) => { await post(`/patients/${deleting.patientId}/prescriptions/${deleting.id}/delete`, { reason }); setDeleting(null); toast.success('Receta eliminada.'); reload(); }} />
      )}
    </>
  );
  return { buttons, dialogs };
}

/** Recetas del paciente, en su ficha: se crean, editan y eliminan sin terminar la cita. */
export function PatientPrescriptions({ patient }: { patient: PatientSummary }) {
  const { can } = useAuth();
  const toast = useToast();
  const list = useAsync(() => get<Prescription[]>(`/patients/${patient.id}/prescriptions`), [patient.id]);
  const [creating, setCreating] = useState(false);
  const actions = usePrescriptionActions({ reload: list.reload, patientEmail: patient.primaryEmail });
  return (
    <section className="card" aria-labelledby="rx-h" style={{ marginTop: 'var(--space-6)' }}>
      <div className="card-head">
        <h2 id="rx-h" className="h3">Recetas</h2>
        {can('clinical:write') && patient.status === 'ACTIVE' && <Button variant="secondary" size="sm" icon={<Plus size={16} aria-hidden="true" />} onClick={() => setCreating(true)}>Nueva receta</Button>}
      </div>
      {list.loading && !list.data && <Loading rows={2} />}
      {list.error != null && <ErrorState error={list.error} onRetry={list.reload} />}
      {list.data?.length === 0 && <EmptyState title="Todavía no hay recetas">Emita una con «Nueva receta»; no hace falta una cita abierta.</EmptyState>}
      {list.data && list.data.length > 0 && (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 'var(--space-4)' }}>
          {list.data.map((r) => (
            <li key={r.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-4)', alignItems: 'center', flexWrap: 'wrap' }}>
              <span><strong>{r.number}</strong> · {fmtDate(r.createdAt)} · {r.prescriber.name}<br /><span className="caption muted">{summary(r)}{r.lastEmailedAt ? ` · Enviada el ${fmtDate(r.lastEmailedAt)}` : ''}</span></span>
              {actions.buttons(r)}
            </li>
          ))}
        </ul>
      )}
      {creating && <PrescriptionDrawer patientId={patient.id} patientName={patient.fullName} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); toast.success('Receta guardada.'); list.reload(); }} />}
      {actions.dialogs(() => patient.fullName)}
    </section>
  );
}

/** Módulo «Recetas»: recetas recientes y emisión para cualquier paciente, sin pasar por una cita. */
export function PrescriptionsPage() {
  const { can } = useAuth();
  const toast = useToast();
  const list = useAsync(() => get<Prescription[]>('/prescriptions', { limit: 50 }), []);
  const [picking, setPicking] = useState(false);
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const actions = usePrescriptionActions({ reload: list.reload });
  return (
    <>
      <div className="page-head"><h1>Recetas</h1>{can('clinical:write') && <Button variant="primary" icon={<Plus size={18} aria-hidden="true" />} onClick={() => setPicking(true)}>Nueva receta</Button>}</div>
      <p className="muted" style={{ marginBottom: 'var(--space-5)' }}>Recetas emitidas recientemente. También puede emitirlas desde la ficha de cada paciente.</p>
      {list.loading && !list.data && <Loading rows={3} />}
      {list.error != null && <ErrorState error={list.error} onRetry={list.reload} />}
      {list.data?.length === 0 && <EmptyState title="Todavía no hay recetas">Cree la primera con «Nueva receta».</EmptyState>}
      {list.data && list.data.length > 0 && (
        <div className="table-wrap table-cards">
          <table>
            <caption className="sr-only">Recetas recientes</caption>
            <thead><tr><th scope="col">Número</th><th scope="col">Fecha</th><th scope="col">Paciente</th><th scope="col">Medicamentos</th><th scope="col">Emitida por</th><th scope="col">Acciones</th></tr></thead>
            <tbody>
              {list.data.map((r) => (
                <tr key={r.id}>
                  <td data-label="Número" className="tabular">{r.number}</td>
                  <td data-label="Fecha">{fmtDate(r.createdAt)}</td>
                  <td data-label="Paciente"><Link className="row-link" to={`/pacientes/${r.patientId}`}>{r.patientName}</Link></td>
                  <td data-label="Medicamentos">{summary(r)}</td>
                  <td data-label="Emitida por">{r.prescriber.name}</td>
                  <td data-label="Acciones">{actions.buttons(r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {picking && <PatientPicker onClose={() => setPicking(false)} onPick={(p) => { setPicking(false); setPatient(p); }} />}
      {patient && <PrescriptionDrawer patientId={patient.id} patientName={patient.fullName} onClose={() => setPatient(null)} onSaved={() => { setPatient(null); toast.success('Receta guardada.'); list.reload(); }} />}
      {actions.dialogs((r) => r.patientName ?? '')}
    </>
  );
}

function PatientPicker({ onClose, onPick }: { onClose: () => void; onPick: (p: PatientSummary) => void }) {
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => { const t = setTimeout(() => setQuery(text.trim()), 300); return () => clearTimeout(t); }, [text]);
  const found = useAsync(() => {
    if (query.length < 2) return Promise.resolve([] as PatientSummary[]);
    const digits = /^\d+$/.test(query);
    return get<PatientSummary[]>('/patients', { ...(digits ? (query.length >= 8 ? { identifier: query } : { phone: query }) : { name: query }), status: 'ACTIVE', limit: 8 });
  }, [query]);
  return (
    <Dialog title="¿Para qué paciente es la receta?" onClose={onClose} footer={<Button onClick={onClose}>Cancelar</Button>}>
      <TextField label="Buscar por DNI, nombre o celular" value={text} onChange={(e) => setText(e.target.value)} help="Escriba al menos 2 caracteres." />
      <div aria-live="polite" style={{ marginTop: 'var(--space-4)' }}>
        {found.error != null && <ErrorState error={found.error} onRetry={found.reload} />}
        {query.length >= 2 && !found.loading && found.data?.length === 0 && <p className="muted">Sin resultados.</p>}
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 'var(--space-2)' }}>
          {found.data?.map((p) => (
            <li key={p.id}>
              <button type="button" className="btn btn-tertiary" style={{ width: '100%', justifyContent: 'flex-start', textAlign: 'left' }} onClick={() => onPick(p)}>
                <span><strong>{p.fullName}</strong><br /><span className="caption muted tabular">{p.identifiers[0] ? `${p.identifiers[0].type} ${p.identifiers[0].number}` : 'Sin documento'}</span></span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Dialog>
  );
}
