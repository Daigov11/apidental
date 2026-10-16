import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Download } from 'lucide-react';
import { downloadFile } from '../lib/download';
import { fmtDateTime } from '../lib/format';
import { Button } from '../ui/Button';
import { useAuth } from '../auth/AuthProvider';
import { Alert, Badge, ErrorState, Loading, errorText, useToast } from '../ui/feedback';
import { OdontogramCanvas, useOdontogram } from './odontogram/useOdontogram';

/** Vista básica del odontograma vigente: figura (SVG del servidor), tabla equivalente accesible y descarga del PDF. */
export function OdontogramPage() {
  const { id = '' } = useParams();
  const toast = useToast();
  const { can } = useAuth();
  const canWrite = can('clinical:write');
  const od = useOdontogram(id);
  const { view, spec, official } = od;
  const [pdfBusy, setPdfBusy] = useState(false);

  const downloadPdf = async () => {
    setPdfBusy(true);
    try {
      await downloadFile(`/patients/${id}/clinical/odontogram/export`, { format: 'pdf', version: official?.version }, `odontograma-v${official?.version ?? ''}.pdf`);
    } catch (e) { toast.error(errorText(e)); }
    finally { setPdfBusy(false); }
  };

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

      <OdontogramCanvas patientId={id} od={od} canWrite={canWrite} />
      {official && !view.data?.draft && (
        <>
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
