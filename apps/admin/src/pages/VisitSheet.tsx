import { Link, useParams } from 'react-router-dom';
import { AlertTriangle, Info, OctagonAlert } from 'lucide-react';
import { get } from '../api/client';
import type { Sheet } from '../api/types';
import { fmtDateTime } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import { Alert, Badge, EmptyState, ErrorState, Loading } from '../ui/feedback';

const SEV = { CRITICAL: { tone: 'danger', Icon: OctagonAlert, label: 'Importante' }, WARNING: { tone: 'warning', Icon: AlertTriangle, label: 'Atención' }, INFO: { tone: 'info', Icon: Info, label: 'Información' } } as const;

/** Ficha de atención de una visita (solo lectura en este incremento). */
export function VisitSheetPage() {
  const { id = '', visitId = '' } = useParams();
  const sheet = useAsync(() => get<Sheet>(`/patients/${id}/clinical/visits/${visitId}/sheet`), [id, visitId]);
  if (sheet.loading && !sheet.data) return <Loading rows={5} label="Cargando la ficha de atención" />;
  if (sheet.error != null) return <ErrorState error={sheet.error} onRetry={sheet.reload} />;
  const s = sheet.data;
  if (!s) return null;
  return (
    <>
      <p><Link to={`/pacientes/${id}`}>‹ {s.patient.fullName}</Link></p>
      <div className="page-head">
        <div>
          <h1>Ficha de atención</h1>
          <p className="muted">{s.patient.fullName} · {s.patient.age ?? '—'} años · Visita {s.visit.number} · {fmtDateTime(s.visit.startedAt)}</p>
        </div>
        <div className="chip-row">
          <Badge tone={s.visit.status === 'OPEN' ? 'info' : 'success'}>{s.visit.statusLabel}</Badge>
          <Link className="btn btn-secondary" to={`/pacientes/${id}/odontograma`}>Ver odontograma</Link>
        </div>
      </div>

      <section aria-labelledby="alerts-h">
        <h2 id="alerts-h" className="sr-only">Alertas</h2>
        {s.alerts.items.map((a) => {
          const sev = SEV[a.severity];
          return <Alert key={a.id} tone={sev.tone} title={`${sev.label}: ${a.label}`} />;
        })}
        <Alert tone={s.allergyAssessment.status === 'ALLERGIES_RECORDED' ? 'warning' : 'info'} title={s.allergyAssessment.label} />
        <Alert tone={s.consent.state === 'GRANTED' ? 'success' : 'warning'} title={s.consent.label} />
      </section>

      <div className="grid-2" style={{ marginTop: 'var(--space-5)' }}>
        <section className="card" aria-labelledby="dx-h">
          <h2 id="dx-h" className="h3" style={{ marginBottom: 'var(--space-4)' }}>Diagnósticos</h2>
          {s.diagnoses.length === 0 ? <EmptyState title="Sin diagnósticos en esta visita" /> : (
            <ul>{s.diagnoses.map((d) => <li key={d.id}>{d.description} <span className="caption muted">· {d.certaintyLabel} · {d.statusLabel}</span></li>)}</ul>
          )}
        </section>
        <section className="card" aria-labelledby="pr-h">
          <h2 id="pr-h" className="h3" style={{ marginBottom: 'var(--space-4)' }}>Procedimientos</h2>
          {s.procedures.length === 0 ? <EmptyState title="Sin procedimientos en esta visita" /> : (
            <ul>{s.procedures.map((p) => <li key={p.id}><strong>{p.name}</strong> <span className="caption muted">· {p.statusLabel}</span>{p.notes && <><br /><span className="caption">{p.notes}</span></>}{p.closeBlockedMessage && <><br /><span className="caption" style={{ color: 'var(--state-warning-fg)' }}>{p.closeBlockedMessage}</span></>}</li>)}</ul>
          )}
        </section>
      </div>

      <section className="card" aria-labelledby="ev-h">
        <div className="card-head"><h2 id="ev-h" className="h3">Evolución</h2>{s.evolution && <Badge tone={s.evolution.state === 'DRAFT' ? 'warning' : 'success'}>{s.evolution.stateLabel}</Badge>}</div>
        {!s.evolution ? <EmptyState title="Aún no hay evolución">El odontólogo la registrará durante la atención.</EmptyState> : s.evolution.contentHidden ? <p className="muted">El contenido no está disponible para su perfil.</p> : (
          <>
            <p style={{ whiteSpace: 'pre-wrap' }}>{s.evolution.body}</p>
            {s.evolution.followUp && <p className="muted" style={{ marginTop: 'var(--space-4)' }}><strong>Seguimiento:</strong> {s.evolution.followUp}</p>}
          </>
        )}
      </section>

      <section className="card" aria-labelledby="od-h">
        <div className="card-head"><h2 id="od-h" className="h3">Odontograma</h2><Link to={`/pacientes/${id}/odontograma`}>Ver odontograma</Link></div>
        {s.odontogram.savedVersion
          ? <p>Versión {s.odontogram.savedVersion.version} · {s.odontogram.savedVersion.stateLabel} · {fmtDateTime(s.odontogram.savedVersion.savedAt)}{s.odontogram.hasDraft ? ' · hay un borrador en curso' : ''}</p>
          : <p className="muted">Todavía no hay un odontograma guardado.</p>}
        <p className="caption muted" style={{ marginTop: 'var(--space-3)' }}>{s.odontogram.formatNotice}</p>
      </section>
      <p className="caption muted">{s.notice}</p>
    </>
  );
}
