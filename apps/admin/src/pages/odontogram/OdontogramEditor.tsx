import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, CircleDot, Eraser, MousePointer2, Save, Trash2 } from 'lucide-react';
import { api, post } from '../../api/client';
import type { Dentition, OdontogramDoc, OdontogramSpecLite, OdontogramVersion, ToothEntry } from '../../api/types';
import { Button } from '../../ui/Button';
import { Alert, Badge, errorText, useToast } from '../../ui/feedback';
import { SelectField, TextAreaField, TextField } from '../../ui/fields';
import { ReasonDialog } from '../../ui/overlays';
import { OdontogramFigure, surfaceSide, toothSummary } from './OdontogramFigure';

type Brush = string; // 'SELECT' | 'ERASE' | código de estado de superficie
type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

const emptyDoc = (): OdontogramDoc => ({ schema: 'apidental.odontogram', schemaVersion: 1, teeth: {} });

/** Quita entradas vacías: la API normaliza igual, pero así lo igual no genera guardados. */
function compact(teeth: Record<string, ToothEntry>): Record<string, ToothEntry> {
  const out: Record<string, ToothEntry> = {};
  for (const [code, t] of Object.entries(teeth)) {
    const e: ToothEntry = {};
    if (t.status && t.status !== 'PRESENT') e.status = t.status;
    if (t.surfaces && Object.keys(t.surfaces).length) e.surfaces = t.surfaces;
    if (t.marks?.length) e.marks = t.marks;
    if (t.note) e.note = t.note;
    if (Object.keys(e).length) out[code] = e;
  }
  return out;
}

/**
 * Editor del borrador: se marca con un pincel (caries, restauración…) sobre la superficie, o se elige la pieza y se
 * completa en el panel. Se guarda solo (PUT …/draft con expectedEtag); «Guardar versión» es el único paso final.
 */
export function OdontogramEditor({ patientId, draft, spec, onFinished }: {
  patientId: string; draft: OdontogramVersion; spec: OdontogramSpecLite; onFinished: (msg: string) => void;
}) {
  const toast = useToast();
  const base = `/patients/${patientId}/clinical/odontogram`;
  const [doc, setDoc] = useState<OdontogramDoc>(() => ({ ...emptyDoc(), ...(draft.data ?? {}) } as OdontogramDoc));
  const [dentition, setDentition] = useState<Dentition>(draft.dentition as Dentition);
  const [selected, setSelected] = useState<string | null>(null);
  const [brush, setBrush] = useState<Brush>('SELECT');
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [password, setPassword] = useState('');
  const [discard, setDiscard] = useState(false);
  const etag = useRef(draft.etag ?? '');
  const latest = useRef({ doc, dentition });
  const inFlight = useRef<Promise<void> | null>(null);
  const dirty = useRef(false);
  const needsReauth = draft.kind === 'CORRECTED' || draft.kind === 'RECTIFIED';

  const flush = useCallback(async (): Promise<void> => {
    if (inFlight.current) { await inFlight.current; }
    if (!dirty.current) return;
    dirty.current = false;
    setSaveState('saving');
    const { doc: d, dentition: dn } = latest.current;
    const run = (async () => {
      try {
        const res = await api<{ draft: OdontogramVersion }>('PUT', `${base}/draft`, {
          body: { data: { ...d, teeth: compact(d.teeth) }, dentition: dn, expectedEtag: etag.current },
        });
        etag.current = res.draft.etag ?? etag.current;
        setSaveError(null);
        setSaveState(dirty.current ? 'dirty' : 'saved');
      } catch (e) {
        dirty.current = true;
        setSaveError(errorText(e));
        setSaveState('error');
        throw e;
      }
    })();
    inFlight.current = run.finally(() => { inFlight.current = null; }).catch(() => undefined);
    await run;
  }, [base]);

  const change = (next: OdontogramDoc, dn: Dentition = dentition) => {
    setDoc(next);
    setDentition(dn);
    latest.current = { doc: next, dentition: dn };
    dirty.current = true;
    setSaveState('dirty');
  };

  useEffect(() => {
    if (saveState !== 'dirty') return;
    const t = setTimeout(() => { void flush().catch(() => undefined); }, 1200);
    return () => clearTimeout(t);
  }, [saveState, doc, dentition, flush]);

  const setTooth = (code: string, fn: (t: ToothEntry) => ToothEntry) => {
    const cur = doc.teeth[code] ?? {};
    change({ ...doc, teeth: { ...doc.teeth, [code]: fn({ ...cur }) } });
  };

  /** Aplica el pincel activo a una superficie de la pieza elegida (otra vez la misma la quita). */
  const applyBrush = (surface: string) => {
    if (!selected || brush === 'SELECT') return;
    setTooth(selected, (t) => {
      const surfaces = { ...(t.surfaces ?? {}) };
      if (brush === 'ERASE' || surfaces[surface]?.state === brush) delete surfaces[surface];
      else surfaces[surface] = { ...(surfaces[surface] ?? {}), state: brush };
      return { ...t, surfaces };
    });
  };

  const tooth = selected ? doc.teeth[selected] ?? {} : null;
  const marksCount = useMemo(() => Object.keys(compact(doc.teeth)).length, [doc]);

  const saveVersion = async () => {
    setClosing(true);
    try {
      await flush();
      await post(`${base}/close`, { expectedEtag: etag.current, ...(needsReauth ? { password } : {}) });
      onFinished('Versión guardada. Quedó registrada y ya no se puede modificar.');
    } catch (e) {
      toast.error(errorText(e));
      setClosing(false);
    }
  };

  const statusText = { saved: 'Guardado', dirty: 'Cambios sin guardar…', saving: 'Guardando…', error: 'No se pudo guardar' }[saveState];

  return (
    <div className="odonto-editor">
      <div className="odonto-bar" role="toolbar" aria-label="Herramientas del odontograma">
        <SelectField
          label="Dentición" value={dentition} disabled={closing}
          onChange={(e) => change(doc, e.target.value as Dentition)}
        >
          {(spec.dentitions ?? []).map((d) => <option key={d.code} value={d.code}>{d.label}</option>)}
        </SelectField>
        <div className="odonto-brushes" role="radiogroup" aria-label="Qué marcar al tocar una superficie">
          <button type="button" role="radio" aria-checked={brush === 'SELECT'} className={`brush${brush === 'SELECT' ? ' is-on' : ''}`} onClick={() => setBrush('SELECT')}>
            <MousePointer2 size={16} aria-hidden="true" /> Elegir pieza
          </button>
          {spec.surfaceStates.map((s) => (
            <button key={s.code} type="button" role="radio" aria-checked={brush === s.code} className={`brush${brush === s.code ? ' is-on' : ''}`} onClick={() => setBrush(s.code)}>
              <svg width="16" height="16" aria-hidden="true"><rect width="16" height="16" rx="3" fill="#fff" stroke={s.color} /><rect width="16" height="16" rx="3" fill={s.pattern === 'solid' ? s.color : 'none'} opacity={s.pattern === 'solid' ? 1 : 0} />{s.pattern === 'hatch' && <path d="M0,10 L10,0 M6,16 L16,6" stroke={s.color} strokeWidth="1.6" />}{s.pattern === 'dots' && <><circle cx="4" cy="4" r="1.5" fill={s.color} /><circle cx="11" cy="11" r="1.5" fill={s.color} /></>}{s.pattern === 'cross' && <path d="M1,1 L15,15 M15,1 L1,15" stroke={s.color} />}{s.pattern === 'grid' && <path d="M0,8 H16 M8,0 V16" stroke={s.color} />}</svg>
              {s.label}
            </button>
          ))}
          <button type="button" role="radio" aria-checked={brush === 'ERASE'} className={`brush${brush === 'ERASE' ? ' is-on' : ''}`} onClick={() => setBrush('ERASE')}>
            <Eraser size={16} aria-hidden="true" /> Quitar
          </button>
        </div>
        <p className="caption muted" aria-live="polite" style={{ marginLeft: 'auto' }}>
          <Badge tone={saveState === 'error' ? 'danger' : saveState === 'saved' ? 'success' : 'neutral'}>{statusText}</Badge>
        </p>
      </div>
      <p className="caption muted">Toque una pieza para elegirla. Con un pincel activo, toque una superficie en la cruz del panel para marcarla; vuelva a tocar la misma para quitarla.</p>
      {saveError && <Alert tone="danger" title="No se pudo guardar el borrador">{saveError} Sus cambios siguen en pantalla; vuelva a intentarlo o recargue la página.</Alert>}

      <div className="odonto-layout">
        <div className="odonto-figure odonto-figure-edit">
          <OdontogramFigure spec={spec} dentition={dentition} teeth={doc.teeth} selected={selected} onSelect={setSelected} />
        </div>

        <aside className="card odonto-side" aria-label="Detalle de la pieza">
          {!selected || !tooth ? (
            <p className="muted">Elija una pieza del dibujo para registrar su estado, hallazgos por superficie y marcas.</p>
          ) : (
            <>
              <h2 className="h3">Pieza {selected}</h2>
              <p className="caption muted" aria-live="polite">{toothSummary(selected, tooth, spec)}</p>
              <div className="odonto-cross" role="group" aria-label={`Superficies de la pieza ${selected}`}>
                {spec.surfaces.map((sf) => {
                  const st = tooth.surfaces?.[sf.code]?.state;
                  const style = spec.surfaceStates.find((x) => x.code === st);
                  return (
                    <button
                      key={sf.code} type="button" className={`cross-btn cross-${surfaceSide(selected, sf.code)}${st ? ' has-state' : ''}`}
                      style={style?.color ? { borderColor: style.color, background: `${style.color}22`, color: style.color } : undefined}
                      aria-label={`${sf.label}${style ? `: ${style.label}` : ': sin hallazgo'}`} title={sf.label}
                      disabled={tooth.status === 'ABSENT'} onClick={() => applyBrush(sf.code)}
                    >{sf.code}</button>
                  );
                })}
              </div>
              <SelectField label="Estado de la pieza" value={tooth.status ?? 'PRESENT'} onChange={(e) => setTooth(selected, (t) => ({ ...t, status: e.target.value }))}>
                {spec.toothStatuses.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
              </SelectField>
              <fieldset disabled={tooth.status === 'ABSENT'}>
                <legend>Superficies</legend>
                {spec.surfaces.map((s) => (
                  <SelectField
                    key={s.code} label={s.label} value={tooth.surfaces?.[s.code]?.state ?? ''}
                    onChange={(e) => setTooth(selected, (t) => {
                      const surfaces = { ...(t.surfaces ?? {}) };
                      if (!e.target.value) delete surfaces[s.code]; else surfaces[s.code] = { ...(surfaces[s.code] ?? {}), state: e.target.value };
                      return { ...t, surfaces };
                    })}
                  >
                    <option value="">Sin hallazgo</option>
                    {spec.surfaceStates.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
                  </SelectField>
                ))}
              </fieldset>
              <fieldset>
                <legend>Marcas</legend>
                {spec.marks.map((m) => (
                  <label key={m.code} className="check">
                    <input
                      type="checkbox" checked={tooth.marks?.includes(m.code) ?? false}
                      onChange={(e) => setTooth(selected, (t) => ({ ...t, marks: e.target.checked ? [...(t.marks ?? []), m.code] : (t.marks ?? []).filter((x) => x !== m.code) }))}
                    /> {m.label}
                  </label>
                ))}
              </fieldset>
              <TextField label="Nota de la pieza" optional maxLength={spec.limits?.toothNote ?? 200} value={tooth.note ?? ''} onChange={(e) => setTooth(selected, (t) => ({ ...t, note: e.target.value }))} />
              <Button variant="tertiary" size="sm" icon={<CircleDot size={16} aria-hidden="true" />} onClick={() => { setTooth(selected, () => ({})); }}>Limpiar la pieza</Button>
            </>
          )}
        </aside>
      </div>

      <div className="card" style={{ marginTop: 'var(--space-6)' }}>
        <TextAreaField label="Notas generales" optional maxLength={spec.limits?.generalNotes ?? 1000} value={doc.notes ?? ''} onChange={(e) => change({ ...doc, notes: e.target.value })} />
        {needsReauth && (
          <TextField
            label="Confirme con su contraseña" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)}
            help="Esta confirmación no es una firma digital, legal ni clínica. Se pide porque es una corrección o rectificación."
          />
        )}
        <div className="toolbar" style={{ justifyContent: 'space-between' }}>
          <span className="muted">{marksCount} pieza(s) con hallazgos · versión {draft.version} en borrador</span>
          <span style={{ display: 'flex', gap: 'var(--space-4)', flexWrap: 'wrap' }}>
            <Button variant="danger" icon={<Trash2 size={18} aria-hidden="true" />} onClick={() => setDiscard(true)} disabled={closing}>Descartar borrador</Button>
            <Button variant="primary" icon={<Save size={18} aria-hidden="true" />} loading={closing} loadingText="Guardando versión…" disabled={needsReauth && !password} onClick={() => void saveVersion()}>Guardar versión</Button>
          </span>
        </div>
        <p className="caption muted" style={{ marginTop: 'var(--space-3)' }}><Check size={14} aria-hidden="true" /> Al guardar la versión queda inmutable; para cambiar algo se abre otra versión.</p>
      </div>

      {discard && (
        <ReasonDialog
          title="Descartar el borrador" example="Se abrió por error" danger confirmLabel="Descartar" explain="El borrador se descarta y se conserva el registro del descarte. La última versión guardada no cambia."
          onClose={() => setDiscard(false)}
          onConfirm={async (reason) => {
            await flush().catch(() => undefined);
            await post(`${base}/discard`, { expectedEtag: etag.current, reason });
            onFinished('Borrador descartado.');
          }}
        />
      )}
    </div>
  );
}
