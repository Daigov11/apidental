import { useEffect, useId, useRef, useState } from 'react';
import { get } from '../api/client';
import type { AgendaService, Availability, PatientSummary, Slot } from '../api/types';
import { useAsync } from '../lib/useAsync';
import { Loading, errorText } from '../ui/feedback';
import { mobileFmt } from '../lib/format';
import { useAuth } from '../auth/AuthProvider';
import { Button } from '../ui/Button';
import { CreatePatientDialog, type PatientInitial } from './CreatePatientDialog';

/** Buscador de pacientes (combobox): por DNI, nombre o celular. */
export function PatientPicker({ onPick, error, createInitial, initialText = '' }: { onPick: (p: PatientSummary | null) => void; error?: string | null; createInitial?: PatientInitial; initialText?: string }) {
  const id = useId();
  const [text, setText] = useState(initialText);
  const [results, setResults] = useState<PatientSummary[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [picked, setPicked] = useState<PatientSummary | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [creating, setCreating] = useState(false);
  const { can } = useAuth();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    clearTimeout(timer.current);
    const q = text.trim();
    if (picked || q.length < 2) { setResults([]); setSearched(false); return; }
    timer.current = setTimeout(() => {
      const digits = /^\d+$/.test(q);
      const query = digits ? (q.length >= 8 ? { identifier: q } : { phone: q }) : { name: q };
      get<PatientSummary[]>('/patients', { ...query, limit: 8 }).then(
        (r) => { setResults(r); setSearched(true); setOpen(true); setActive(0); setFailed(null); },
        (e: unknown) => setFailed(errorText(e)),
      );
    }, 250);
    return () => clearTimeout(timer.current);
  }, [text, picked]);

  const choose = (p: PatientSummary) => { setPicked(p); setText(p.fullName); setOpen(false); onPick(p); };
  return (
    <div className="field">
      <label htmlFor={id} className="field-label">Paciente</label>
      <div className="combo">
        <input
          id={id} className="input" role="combobox" aria-expanded={open} aria-controls={`${id}-list`} aria-autocomplete="list" autoComplete="off"
          aria-invalid={error ? true : undefined} placeholder="Buscar por DNI, nombre o celular" value={text}
          onChange={(e) => { setText(e.target.value); if (picked) { setPicked(null); onPick(null); } }}
          onKeyDown={(e) => {
            if (!open || results.length === 0) return;
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
            else if (e.key === 'Enter') { e.preventDefault(); choose(results[active]!); }
            else if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); }
          }}
        />
        {open && searched && results.length === 0 && !picked && !failed && (
          <div className="combo-list combo-empty" role="status">
            <p>No se encontró a «{text.trim()}».</p>
            {can('patient:write')
              ? <Button type="button" variant="primary" size="sm" onClick={() => { setOpen(false); setCreating(true); }}>Crear paciente nuevo</Button>
              : <p className="caption muted">Pida a recepción que lo registre.</p>}
          </div>
        )}
        {open && results.length > 0 && (
          <ul id={`${id}-list`} role="listbox" className="combo-list" aria-label="Pacientes encontrados">
            {results.map((p, i) => (
              <li key={p.id} role="option" aria-selected={i === active} onMouseDown={(e) => { e.preventDefault(); choose(p); }}>
                <strong>{p.fullName}</strong>
                <span className="caption muted"> · {p.identifiers[0] ? `${p.identifiers[0].type} ${p.identifiers[0].number}` : 'sin documento'} · {mobileFmt(p.primaryMobile)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="field-help" aria-live="polite">
        {failed ?? (picked ? 'Paciente elegido.' : text.trim().length >= 2 && searched && results.length === 0 ? 'Sin resultados. Revise el dato o cree al paciente.' : 'Escriba al menos 2 caracteres.')}
      </p>
      {error && <p className="field-error" role="alert">{error}</p>}
      {creating && <CreatePatientDialog initialText={text} initial={createInitial} onClose={() => setCreating(false)} onCreated={(p) => { setCreating(false); choose(p); }} />}
    </div>
  );
}

/** Horarios libres para un servicio, odontólogo y fecha (la API ya descuenta citas y bloqueos). */
export function SlotPicker({
  branchId, serviceId, dentistUserId, date, ignoreAppointmentId, value, onChange, reloadKey = 0, preferredStartsAt, onPreferredChecked,
}: {
  branchId: string; serviceId: string; dentistUserId: string; date: string; ignoreAppointmentId?: string;
  value: Slot | null; onChange: (s: Slot | null) => void; reloadKey?: number;
  /** Si está libre al cargar, se elige solo; `onPreferredChecked` avisa si estaba libre. */
  preferredStartsAt?: string; onPreferredChecked?: (found: boolean) => void;
}) {
  const name = useId();
  const ready = Boolean(branchId && serviceId && dentistUserId && date);
  const res = useAsync(
    (signal) => (ready ? get<Availability>('/agenda/availability', { branchId, from: date, serviceId, dentistUserId, ignoreAppointmentId }, signal) : Promise.resolve(null)),
    [branchId, serviceId, dentistUserId, date, ignoreAppointmentId, reloadKey],
  );
  const checked = useRef<string | null>(null);
  useEffect(() => {
    if (!preferredStartsAt || !res.data) return;
    const key = `${dentistUserId}|${date}|${res.data.slots.length}`;
    if (checked.current === key) return;
    checked.current = key;
    const match = res.data.slots.find((x) => x.startsAt === preferredStartsAt);
    if (match) onChange(match);
    onPreferredChecked?.(Boolean(match));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [res.data, preferredStartsAt]);
  return (
    <fieldset>
      <legend>Horarios disponibles</legend>
      {!ready && <p className="muted">Elija servicio, odontólogo y fecha para ver los horarios.</p>}
      {ready && res.loading && <Loading label="Buscando horarios" rows={1} />}
      {ready && res.error != null && <p className="field-error" role="alert">{errorText(res.error)}</p>}
      {ready && !res.loading && res.data && res.data.slots.length === 0 && <p className="muted">No hay horarios libres ese día. Pruebe otra fecha u otro odontólogo.</p>}
      {ready && res.data && res.data.slots.length > 0 && (
        <div className="slot-grid" role="radiogroup" aria-label="Horarios disponibles">
          {res.data.slots.map((s) => (
            <label key={s.startsAt}>
              <input type="radio" name={name} checked={value?.startsAt === s.startsAt} onChange={() => onChange(s)} />
              {s.time}
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}

export function useServices() {
  return useAsync(async () => (await get<AgendaService[]>('/agenda/services')).filter((s) => s.active), []);
}
