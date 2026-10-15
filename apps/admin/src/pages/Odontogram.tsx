import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Download, Pencil } from 'lucide-react';
import { get, post } from '../api/client';
import type { Dentition, OdontogramSpecLite, OdontogramView } from '../api/types';
import { downloadFile } from '../lib/download';
import { fmtDateTime } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import { Button } from '../ui/Button';
import { Alert, Badge, EmptyState, ErrorState, Loading, errorText, useToast } from '../ui/feedback';
import { ReasonDialog } from '../ui/overlays';
import { OdontogramEditor } from './odontogram/OdontogramEditor';
import { OdontogramFigure } from './odontogram/OdontogramFigure';

/** Vista básica del odontograma vigente: figura (SVG del servidor), tabla equivalente accesible y descarga del PDF. */
export function OdontogramPage() {
  const { id = '' } = useParams();
  const toast = useToast();
  const view = useAsync(() => get<OdontogramView>(`/patients/${id}/clinical/odontogram`), [id]);
  const spec = useAsync(() => get<OdontogramSpecLite>('/clinical/odontogram/spec'), []);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const [correcting, setCorrecting] = useState<'CORRECTION' | 'RECTIFICATION' | null>(null);
  const official = view.data?.official ?? null;

  const downloadPdf = async () => {
    setPdfBusy(true);
    try {
      await downloadFile(`/patients/${id}/clinical/odontogram/export`, { format: 'pdf', version: official?.version }, `odontograma-v${official?.version ?? ''}.pdf`);
    } catch (e) { toast.error(errorText(e)); }
    finally { setPdfBusy(false); }
  };

  const start = async (purpose?: 'UPDATE', reason?: string, kind?: 'CORRECTION' | 'RECTIFICATION') => {
    setStarting(true);
    try {
      await post(`/patients/${id}/clinical/odontogram/draft`, { purpose: kind ?? purpose, ...(reason ? { reason } : {}), ...(!official ? { dentition: 'PERMANENT' } : {}) });
      view.reload();
    } catch (e) { toast.error(errorText(e)); }
    finally { setStarting(false); }
  };
  const finished = (msg: string) => { toast.success(msg); view.reload(); };

  if (view.loading && !view.data) return <Loading rows={4} label="Cargando el odontograma" />;
  if (view.error != null) return <ErrorState error={view.error} onRetry={view.reload} />;
  const label = (list: { code: string; label: string }[] | undefined, code: string) => list?.find((x) => x.code === code)?.label ?? code;
  const teeth = Object.entries(official?.data?.teeth ?? {}).sort(([a], [b]) => Number(a) - Number(b));

  return (
    <>
      <p><Link to={`/pacientes/${id}`}>‹ Paciente</Link></p>
      <div className="page-head">
        <div>
          <h1>Odontograma</h1>
          {official && <p className="muted">Versión {official.version} · {official.stateLabel} · {official.dentitionLabel}{official.lastChange ? ` · ${fmtDateTime(official.lastChange.at)}` : ''}</p>}
        </div>
        {official && <Button icon={<Download size={18} aria-hidden="true" />} loading={pdfBusy} loadingText="Preparando…" onClick={() => void downloadPdf()}>Descargar PDF</Button>}
      </div>
      <Alert tone="info">{view.data?.formatNotice ?? 'Formato clínico por validar.'} El odontograma registra lo que el profesional observa; no genera tratamientos ni presupuestos.</Alert>

      {view.data?.draft && view.data.draftIsMine && spec.data?.layout && (
        <OdontogramEditor key={view.data.draft.version} patientId={id} draft={view.data.draft} spec={spec.data} onFinished={finished} />
      )}
      {view.data?.draft && !view.data.draftIsMine && <Alert tone="warning">Hay un borrador en curso de otro odontólogo.</Alert>}
      {!view.data?.draft && (
        <div className="toolbar" style={{ gap: 'var(--space-4)' }}>
          <Button variant="primary" icon={<Pencil size={18} aria-hidden="true" />} loading={starting} loadingText="Abriendo…" onClick={() => void start('UPDATE')}>
            {official ? 'Actualizar odontograma' : 'Iniciar odontograma'}
          </Button>
          {official && <Button onClick={() => setCorrecting('CORRECTION')}>Corregir la versión guardada</Button>}
        </div>
      )}
      {correcting && (
        <ReasonDialog
          title="Corregir el odontograma" example="Se registró la pieza equivocada" confirmLabel="Abrir corrección" explain="Se abre un borrador nuevo a partir de la última versión guardada. Al guardarlo se pedirá su contraseña."
          onClose={() => setCorrecting(null)}
          onConfirm={async (reason) => { await start(undefined, reason, correcting); setCorrecting(null); }}
        />
      )}
      {!official && !view.data?.draft && <EmptyState title="Todavía no hay un odontograma guardado">Use «Iniciar odontograma» para registrarlo durante la atención.</EmptyState>}
      {official && !view.data?.draft && (
        <>
          <div className="odonto-figure odonto-figure-edit">
            {spec.data?.layout && official.data
              ? <OdontogramFigure spec={spec.data} dentition={official.dentition as Dentition} teeth={official.data.teeth} selected={null} />
              : official.contentHidden ? <p className="muted">El detalle no está disponible para su perfil.</p> : <Loading rows={2} label="Preparando el dibujo" />}
          </div>
          <section className="card" aria-labelledby="od-table-h" style={{ marginTop: 'var(--space-6)' }}>
            <h2 id="od-table-h" className="h3" style={{ marginBottom: 'var(--space-4)' }}>Vista de tabla</h2>
            {official.contentHidden ? <p className="muted">El detalle no está disponible para su perfil.</p> : teeth.length === 0 ? <p className="muted">No hay piezas con hallazgos registrados: todas figuran sin novedades.</p> : (
              <div className="table-wrap table-cards">
                <table>
                  <caption className="sr-only">Piezas con hallazgos registrados</caption>
                  <thead><tr><th scope="col">Pieza</th><th scope="col">Estado</th><th scope="col">Superficies</th><th scope="col">Marcas</th></tr></thead>
                  <tbody>
                    {teeth.map(([code, t]) => (
                      <tr key={code}>
                        <th scope="row" data-label="Pieza">Pieza {code}</th>
                        <td data-label="Estado">{label(spec.data?.toothStatuses, t.status ?? 'PRESENT')}</td>
                        <td data-label="Superficies">{Object.entries(t.surfaces ?? {}).map(([s, v]) => `${label(spec.data?.surfaces, s)}: ${label(spec.data?.surfaceStates, v.state)}`).join('; ') || '—'}</td>
                        <td data-label="Marcas">{(t.marks ?? []).map((m) => label(spec.data?.marks, m)).join(', ') || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {official.data?.notes && <p className="muted" style={{ marginTop: 'var(--space-4)' }}>{official.data.notes}</p>}
            <p style={{ marginTop: 'var(--space-4)' }}><Badge tone="neutral">{view.data?.versionsCount ?? 1} versión(es) guardada(s)</Badge></p>
          </section>
        </>
      )}
    </>
  );
}
