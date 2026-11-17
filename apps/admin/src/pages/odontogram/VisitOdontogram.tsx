import { useState } from 'react';
import { ArrowRight, Download, Pencil } from 'lucide-react';
import { get, post } from '../../api/client';
import type { Dentition, OdontogramSpecLite, ToothEntry, VisitOdontogramPhase, VisitOdontogramVersion, VisitOdontogramView } from '../../api/types';
import { downloadFile } from '../../lib/download';
import { fmtDateTime } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';
import { Button } from '../../ui/Button';
import { Alert, Badge, ErrorState, Loading, errorText, useToast } from '../../ui/feedback';
import { OdontogramEditor } from './OdontogramEditor';
import { OdontogramFigure, toothSummary } from './OdontogramFigure';

type Tab = VisitOdontogramPhase | 'COMPARE';
const TABS: { key: Tab; label: string; hint: string }[] = [
  { key: 'DIAGNOSIS', label: 'Diagnóstico', hint: 'Cómo llega el paciente' },
  { key: 'POST_TREATMENT', label: 'Post tratamiento', hint: 'Cómo sale el paciente' },
  { key: 'COMPARE', label: 'Comparar', hint: 'Antes y después' },
];

/** Piezas que cambiaron entre dos odontogramas, con la descripción de cada lado. */
export function diffTeeth(before: Record<string, ToothEntry>, after: Record<string, ToothEntry>, spec: OdontogramSpecLite) {
  const describe = (code: string, t: ToothEntry | undefined) => {
    const base = toothSummary(code, t, spec).replace(`Pieza ${code}: `, '');
    return t?.note ? `${base} (nota: ${t.note})` : base;
  };
  const codes = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort((a, b) => Number(a) - Number(b));
  return codes
    .filter((c) => JSON.stringify(before[c] ?? {}) !== JSON.stringify(after[c] ?? {}))
    .map((c) => ({ tooth: c, before: describe(c, before[c]), after: describe(c, after[c]) }));
}

const live = (v: VisitOdontogramVersion | null | undefined) => (v && v.state !== 'DISCARDED' ? v : null);
const saved = (v: VisitOdontogramVersion | null | undefined) => (v && (v.state === 'CLOSED' || v.state === 'CORRECTED') ? v : null);

/**
 * Odontograma de la visita en dos fases, como en la ficha en papel: DIAGNÓSTICO (cómo llega el paciente) y POST TRATAMIENTO
 * (cómo sale), más la comparación de ambos. El diagnóstico parte del odontograma vigente del paciente; el post tratamiento,
 * del diagnóstico guardado. Al cerrar la visita, el último guardado pasa a ser el odontograma vigente del paciente.
 */
export function VisitOdontogram({ patientId, visitId, editable, onChanged }: { patientId: string; visitId: string; editable: boolean; onChanged?: () => void }) {
  const toast = useToast();
  const base = `/patients/${patientId}/clinical/visits/${visitId}/odontogram`;
  const view = useAsync(() => get<VisitOdontogramView>(base), [base]);
  const spec = useAsync(() => get<OdontogramSpecLite>('/clinical/odontogram/spec'), []);
  const [chosen, setChosen] = useState<Tab | null>(null);
  const [busy, setBusy] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [correcting, setCorrecting] = useState<VisitOdontogramPhase | null>(null);

  const refresh = (msg?: string) => {
    if (msg) toast.success(msg);
    view.reload();
    onChanged?.();
  };
  const phases = view.data?.phases;
  const A = view.data?.actions;
  // Por omisión se abre la fase en la que se está trabajando: el post tratamiento en cuanto el diagnóstico está guardado.
  const tab: Tab = chosen ?? (saved(phases?.DIAGNOSIS) && (live(phases?.POST_TREATMENT) || A?.canStartPost) ? 'POST_TREATMENT' : 'DIAGNOSIS');

  const start = async (phase: VisitOdontogramPhase) => {
    setBusy(true);
    try {
      await post(`${base}/${phase}/draft`, {});
      setChosen(phase);
      refresh();
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const downloadPdf = async () => {
    setPdfBusy(true);
    try {
      await downloadFile(`${base}/export`, {}, `odontograma-visita.pdf`);
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setPdfBusy(false);
    }
  };

  const anySaved = !!(saved(phases?.DIAGNOSIS) || saved(phases?.POST_TREATMENT));

  return (
    <section className="card" aria-labelledby="od-h">
      <div className="card-head">
        <h2 id="od-h" className="h3">Odontograma</h2>
        <span className="row-actions">
          {anySaved && <Button size="sm" icon={<Download size={16} aria-hidden="true" />} loading={pdfBusy} loadingText="Preparando…" onClick={() => void downloadPdf()}>Descargar PDF</Button>}
        </span>
      </div>

      <div className="tabs" role="tablist" aria-label="Fases del odontograma">
        {TABS.map((t) => {
          const v = t.key === 'COMPARE' ? null : live(phases?.[t.key]);
          return (
            <button key={t.key} type="button" role="tab" id={`od-tab-${t.key}`} aria-selected={tab === t.key} aria-controls="od-panel" onClick={() => { setChosen(t.key); setCorrecting(null); }}>
              {t.label}
              {v && <Badge tone={v.state === 'DRAFT' ? 'warning' : 'success'}>{v.state === 'DRAFT' ? 'Borrador' : 'Guardado'}</Badge>}
            </button>
          );
        })}
      </div>

      <div id="od-panel" role="tabpanel" aria-labelledby={`od-tab-${tab}`}>
        <p className="caption muted" style={{ marginBottom: 'var(--space-4)' }}>{TABS.find((t) => t.key === tab)?.hint}</p>
        {(view.loading && !view.data) || (spec.loading && !spec.data) ? <Loading rows={2} label="Cargando el odontograma" />
          : view.error != null ? <ErrorState error={view.error} onRetry={view.reload} />
          : !spec.data || !phases || !A ? null
          : tab === 'COMPARE' ? <Compare spec={spec.data} before={live(phases.DIAGNOSIS)} after={live(phases.POST_TREATMENT)} />
          : (
            <PhasePanel
              phase={tab} v={live(phases[tab])} spec={spec.data} base={base} patientId={patientId} editable={editable}
              canStart={tab === 'DIAGNOSIS' ? A.canStartDiagnosis : A.canStartPost} canCorrect={A.canCorrect}
              diagnosisSaved={!!saved(phases.DIAGNOSIS)} busy={busy} onStart={() => void start(tab)}
              correcting={correcting === tab} setCorrecting={(on) => setCorrecting(on ? tab : null)}
              onFinished={refresh}
              onCorrect={async (data, dentition, reason, password) => {
                try {
                  await post(`${base}/${tab}/correct`, { expectedEtag: phases[tab]!.etag, data, dentition, reason, password });
                  setCorrecting(null);
                  refresh('Corrección guardada. La versión anterior se conserva.');
                } catch (e) {
                  toast.error(errorText(e));
                  throw e;
                }
              }}
            />
          )}
        <p className="caption muted" style={{ marginTop: 'var(--space-3)' }}>{view.data?.formatNotice}</p>
      </div>
    </section>
  );
}

function PhasePanel({ phase, v, spec, base, patientId, editable, canStart, canCorrect, diagnosisSaved, busy, onStart, correcting, setCorrecting, onFinished, onCorrect }: {
  phase: VisitOdontogramPhase; v: VisitOdontogramVersion | null; spec: OdontogramSpecLite; base: string; patientId: string; editable: boolean;
  canStart: boolean; canCorrect: boolean; diagnosisSaved: boolean; busy: boolean; onStart: () => void;
  correcting: boolean; setCorrecting: (on: boolean) => void; onFinished: (msg: string) => void;
  onCorrect: (data: { teeth: Record<string, ToothEntry>; notes?: string }, dentition: Dentition, reason: string, password: string) => Promise<void>;
}) {
  if (!v) {
    if (phase === 'POST_TREATMENT' && !diagnosisSaved)
      return <p className="muted">Guarde primero el odontograma de diagnóstico: el post tratamiento parte de él.</p>;
    return (
      <div>
        <p className="muted">
          {phase === 'DIAGNOSIS'
            ? 'Registre cómo llega el paciente. Se parte del odontograma vigente del paciente (o de uno en blanco si es el primero).'
            : 'Registre cómo sale el paciente después de la atención. Se parte del odontograma de diagnóstico.'}
        </p>
        {canStart && editable && (
          <Button variant="primary" icon={<Pencil size={18} aria-hidden="true" />} loading={busy} loadingText="Abriendo…" onClick={onStart}>
            {phase === 'DIAGNOSIS' ? 'Iniciar odontograma de diagnóstico' : 'Iniciar odontograma post tratamiento'}
          </Button>
        )}
      </div>
    );
  }
  if (v.state === 'DRAFT') {
    if (v.contentHidden) return <Alert tone="info">El odontólogo responsable está registrando esta fase.</Alert>;
    if (editable && spec.layout)
      return <OdontogramEditor key={`${phase}-${v.version}`} patientId={patientId} base={`${base}/${phase}`} draft={v} spec={spec} onFinished={onFinished} />;
  }
  if (correcting && spec.layout)
    return (
      <OdontogramEditor
        key={`${phase}-fix-${v.version}`} patientId={patientId} draft={v} spec={spec} onFinished={onFinished}
        correction={{ onSubmit: (data, dentition, reason, password) => onCorrect(data, dentition, reason, password), onCancel: () => setCorrecting(false) }}
      />
    );
  return (
    <div>
      <p className="caption muted" style={{ marginBottom: 'var(--space-3)' }}>
        Versión {v.version} · {v.stateLabel}{v.closure?.savedAt ? ` el ${fmtDateTime(v.closure.savedAt)}` : ''} · {v.dentitionLabel}
        {v.state === 'CORRECTED' && v.lastChange?.reason ? ` · Motivo: ${v.lastChange.reason}` : ''}
      </p>
      {!v.data ? <p className="muted">El detalle no está disponible para su perfil.</p>
        : spec.layout && <div className="odonto-figure odonto-figure-edit"><OdontogramFigure spec={spec} dentition={v.dentition as Dentition} teeth={v.data.teeth} selected={null} /></div>}
      {v.data?.notes && <p style={{ marginTop: 'var(--space-3)' }}><strong>Notas:</strong> {v.data.notes}</p>}
      {canCorrect && v.data && (
        <div className="toolbar" style={{ marginTop: 'var(--space-4)' }}>
          <Button onClick={() => setCorrecting(true)}>Corregir esta fase</Button>
        </div>
      )}
    </div>
  );
}

function Compare({ spec, before, after }: { spec: OdontogramSpecLite; before: VisitOdontogramVersion | null; after: VisitOdontogramVersion | null }) {
  if (!before?.data || !after?.data)
    return <p className="muted">La comparación aparece cuando hay odontograma de diagnóstico y post tratamiento.</p>;
  const changes = diffTeeth(before.data.teeth, after.data.teeth, spec);
  return (
    <div>
      <div className="odonto-compare">
        {[before, after].map((v) => (
          <figure key={v.phase} className="odonto-figure">
            <figcaption style={{ fontWeight: 600, marginBottom: 'var(--space-3)' }}>
              {v.phase === 'DIAGNOSIS' ? 'Antes · diagnóstico' : 'Después · post tratamiento'} {v.state === 'DRAFT' && <Badge tone="warning">Borrador</Badge>}
            </figcaption>
            {spec.layout && <OdontogramFigure spec={spec} dentition={v.dentition as Dentition} teeth={v.data!.teeth} selected={null} zoom={1.2} />}
          </figure>
        ))}
      </div>
      <h3 style={{ fontSize: 'inherit', margin: 'var(--space-5) 0 var(--space-3)' }}>Piezas que cambiaron ({changes.length})</h3>
      {changes.length === 0 ? <p className="muted">No hay cambios entre el diagnóstico y el post tratamiento.</p> : (
        <ul className="odonto-changes">
          {changes.map((c) => (
            <li key={c.tooth}>
              <strong>Pieza {c.tooth}</strong>
              <span className="muted">{c.before}</span>
              <ArrowRight size={14} aria-label="pasa a" />
              <span>{c.after}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
