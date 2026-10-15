import { useState, type FormEvent, type ReactNode } from 'react';
import { api, get } from '../api/client';
import type { ProcedureDefinition, Sheet } from '../api/types';
import { useAsync } from '../lib/useAsync';
import { Button } from '../ui/Button';
import { SelectField, TextAreaField, TextField } from '../ui/fields';
import { Alert, Loading, errorText } from '../ui/feedback';
import { Dialog } from '../ui/overlays';

type Submit = (fn: () => Promise<unknown>, ok: string) => Promise<void>;
interface DialogProps { patientId: string; commit: Submit; onClose: () => void }

export const CLOSE_BLOCKERS: Record<string, string> = {
  OPEN_PROCEDURES: 'Hay procedimientos abiertos: ciérrelos o cancélelos antes de cerrar la visita.',
  OPEN_NOTE: 'La evolución está en borrador: ciérrela o descártela antes de cerrar la visita.',
};

const SOURCES = [['PATIENT', 'El paciente'], ['GUARDIAN', 'Su representante'], ['DOCUMENT', 'Un documento'], ['PROFESSIONAL', 'Mi valoración'], ['OTHER', 'Otro']] as const;
const SEVERITIES = [['NOT_SPECIFIED', 'No especificada'], ['MILD', 'Leve'], ['MODERATE', 'Moderada'], ['SEVERE', 'Severa']] as const;
const ALLERGY_KINDS = ['Medicamento', 'Anestésico', 'Látex', 'Material', 'Alimento', 'Otro'];

/** Diálogo de formulario con envío, estado de espera y error visible. */
function FormDialog({ title, submitLabel, onClose, onSubmit, children, invalid }: {
  title: string; submitLabel: string; onClose: () => void; onSubmit: () => Promise<void>; children: ReactNode; invalid?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (invalid) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Volver</Button>
          <Button type="submit" form="visit-form" variant="primary" loading={busy} loadingText="Guardando…">{submitLabel}</Button>
        </>
      }
    >
      <form id="visit-form" onSubmit={submit} noValidate>
        {children}
        {touched && invalid && <p className="field-error" role="alert">Complete los campos obligatorios.</p>}
        {error && <p className="field-error" role="alert">{error}</p>}
      </form>
    </Dialog>
  );
}

const base = (patientId: string) => `/patients/${patientId}/clinical`;

// ------------------------------------------------------------------------------------------- alergias
export function AllergyDialog({ patientId, assessment, commit, onClose }: DialogProps & { assessment: Sheet['allergyAssessment'] }) {
  const canDeclareNone = assessment.activeAllergyCount === 0;
  const [mode, setMode] = useState<'none' | 'has'>(canDeclareNone ? 'none' : 'has');
  const [source, setSource] = useState('PATIENT');
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState('Medicamento');
  const [severity, setSeverity] = useState('NOT_SPECIFIED');
  const [critical, setCritical] = useState(false);
  const [notes, setNotes] = useState('');
  const [reason, setReason] = useState('');
  const version = assessment.version ?? 0;
  const needsReason = mode === 'none' && version >= 1;
  const invalid = (mode === 'has' && label.trim().length < 2) || (needsReason && reason.trim().length < 3);
  const submit = () =>
    commit(
      () =>
        mode === 'none'
          ? api('PUT', `${base(patientId)}/allergy-assessment`, { body: { status: 'NO_KNOWN_ALLERGIES', source, expectedVersion: version, ...(notes.trim() ? { observations: notes.trim() } : {}), ...(needsReason ? { reason: reason.trim() } : {}) } })
          : api('POST', `${base(patientId)}/history`, { body: { kind: 'ALLERGY', label: label.trim(), category: kind, severity, isCritical: critical, source, ...(notes.trim() ? { observations: notes.trim() } : {}) } }),
      mode === 'none' ? 'Se registró: sin alergias conocidas.' : 'Alergia registrada.',
    );
  return (
    <FormDialog title="Evaluación de alergias" submitLabel="Guardar" onClose={onClose} onSubmit={submit} invalid={invalid}>
      <p className="muted">Registre lo que el paciente (o su representante) le informa. Es una declaración del profesional.</p>
      {canDeclareNone && (
        <fieldset className="field" style={{ border: 0, padding: 0 }}>
          <legend className="field-label">¿Qué informa el paciente?</legend>
          <label style={{ display: 'block' }}><input type="radio" name="allergy-mode" checked={mode === 'none'} onChange={() => setMode('none')} /> No refiere alergias conocidas</label>
          <label style={{ display: 'block' }}><input type="radio" name="allergy-mode" checked={mode === 'has'} onChange={() => setMode('has')} /> Tiene una alergia</label>
        </fieldset>
      )}
      {mode === 'has' && (
        <>
          <TextField label="Alergia" help="Por ejemplo: Penicilina, látex, anestésico local." value={label} onChange={(e) => setLabel(e.target.value)} maxLength={200} />
          <SelectField label="Tipo" value={kind} onChange={(e) => setKind(e.target.value)}>{ALLERGY_KINDS.map((k) => <option key={k}>{k}</option>)}</SelectField>
          <SelectField label="Gravedad" value={severity} onChange={(e) => setSeverity(e.target.value)}>{SEVERITIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</SelectField>
          <label style={{ display: 'block', marginBottom: 'var(--space-4)' }}><input type="checkbox" checked={critical} onChange={(e) => setCritical(e.target.checked)} /> Mostrar como alerta importante</label>
        </>
      )}
      <SelectField label="Quién lo informa" value={source} onChange={(e) => setSource(e.target.value)}>{SOURCES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</SelectField>
      <TextAreaField label="Observaciones" optional value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
      {needsReason && <TextAreaField label="Motivo del cambio" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />}
    </FormDialog>
  );
}

// ---------------------------------------------------------------------------------------- diagnósticos
export function DiagnosisDialog({ patientId, visitId, current, commit, onClose }: DialogProps & { visitId: string; current?: Sheet['diagnoses'][number] }) {
  const [description, setDescription] = useState(current?.description ?? '');
  const [certainty, setCertainty] = useState(current?.certainty ?? 'PRESUMPTIVE');
  const [code, setCode] = useState(current?.code ?? '');
  const [reason, setReason] = useState('');
  const editing = Boolean(current);
  const invalid = description.trim().length < 2 || (editing && reason.trim().length < 3);
  const submit = () =>
    commit(
      () =>
        editing
          ? api('POST', `${base(patientId)}/diagnoses/${current!.id}/correct`, { body: { expectedVersion: current!.version ?? 1, reason: reason.trim(), description: description.trim(), certainty, code: code.trim() || null } })
          : api('POST', `${base(patientId)}/visits/${visitId}/diagnoses`, { body: { description: description.trim(), certainty, ...(code.trim() ? { code: code.trim() } : {}) } }),
      editing ? 'Diagnóstico corregido.' : 'Diagnóstico agregado.',
    );
  return (
    <FormDialog title={editing ? 'Corregir diagnóstico' : 'Agregar diagnóstico'} submitLabel={editing ? 'Guardar corrección' : 'Agregar'} onClose={onClose} onSubmit={submit} invalid={invalid}>
      <p className="muted">Escriba el diagnóstico con sus palabras. El sistema no sugiere ni decide diagnósticos.</p>
      <TextAreaField label="Diagnóstico" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
      <SelectField label="Certeza" value={certainty} onChange={(e) => setCertainty(e.target.value)}>
        <option value="PRESUMPTIVE">Presuntivo</option>
        <option value="DEFINITIVE">Definitivo</option>
      </SelectField>
      <TextField label="Código interno" optional value={code} onChange={(e) => setCode(e.target.value)} maxLength={40} />
      {editing && <TextAreaField label="Motivo de la corrección" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />}
    </FormDialog>
  );
}

// ---------------------------------------------------------------------------------------- procedimientos
export function ProcedureDialog({ patientId, visitId, commit, onClose }: DialogProps & { visitId: string }) {
  const defs = useAsync((signal) => get<ProcedureDefinition[]>('/procedure-definitions', { status: 'ACTIVE', limit: 100 }, signal), []);
  const [definitionId, setDefinitionId] = useState('');
  const [notes, setNotes] = useState('');
  const invalid = !definitionId;
  const submit = () => commit(() => api('POST', `${base(patientId)}/visits/${visitId}/procedures`, { body: { definitionId, ...(notes.trim() ? { notes: notes.trim() } : {}) } }), 'Procedimiento agregado.');
  return (
    <FormDialog title="Agregar procedimiento" submitLabel="Agregar" onClose={onClose} onSubmit={submit} invalid={invalid}>
      {defs.loading && <Loading label="Cargando el catálogo" rows={1} />}
      {defs.error != null && <Alert tone="danger" title="No se pudo cargar el catálogo de procedimientos." />}
      {defs.data && defs.data.length === 0 && <Alert tone="warning" title="El catálogo de procedimientos está vacío. Pida al administrador que lo configure." />}
      {defs.data && defs.data.length > 0 && (
        <SelectField label="Procedimiento" value={definitionId} onChange={(e) => setDefinitionId(e.target.value)}>
          <option value="">Elija…</option>
          {defs.data.map((d) => <option key={d.id} value={d.id}>{d.name}{d.requiresClinicalConsent ? ' (exige consentimiento)' : ''}</option>)}
        </SelectField>
      )}
      <TextAreaField label="Notas" optional value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} help="Pieza, material u otro dato que quiera dejar." />
    </FormDialog>
  );
}

// ------------------------------------------------------------------------------------------- evolución
/** Confirmación de identidad con la contraseña (no es una firma digital). */
export function PasswordDialog({ title, explain, confirmLabel, withReason, onConfirm, onClose, extra }: {
  title: string; explain: string; confirmLabel: string; withReason?: boolean; onConfirm: (password: string, reason: string) => Promise<void>; onClose: () => void; extra?: ReactNode;
}) {
  const [password, setPassword] = useState('');
  const [reason, setReason] = useState('');
  const invalid = password.length === 0 || (withReason === true && reason.trim().length < 3);
  return (
    <FormDialog title={title} submitLabel={confirmLabel} onClose={onClose} invalid={invalid} onSubmit={() => onConfirm(password, reason.trim())}>
      <p className="muted">{explain}</p>
      {extra}
      {withReason && <TextAreaField label="Motivo" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />}
      <TextField label="Su contraseña" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} help="Es una confirmación de su identidad; no es una firma digital." />
    </FormDialog>
  );
}

export function ConfirmDialog({ title, explain, confirmLabel, onConfirm, onClose }: { title: string; explain: ReactNode; confirmLabel: string; onConfirm: () => Promise<void>; onClose: () => void }) {
  return (
    <FormDialog title={title} submitLabel={confirmLabel} onClose={onClose} onSubmit={onConfirm}>
      <div className="muted">{explain}</div>
    </FormDialog>
  );
}
