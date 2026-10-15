import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ClipboardList, Plus, ShieldAlert } from 'lucide-react';
import { ApiError, get } from '../api/client';
import type { Appointment, PatientDetail, VisitRow } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { useBranch } from '../lib/branch';
import { fmtDate, fmtLongDay, dayOf, mobileFmt, timeOf } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import { Button } from '../ui/Button';
import { Alert, Badge, EmptyState, ErrorState, Loading, StatusBadge } from '../ui/feedback';
import { useIntegrations } from '../lib/integrations';
import { AppointmentDrawer, NewAppointmentDrawer } from './AppointmentPanels';
import { LoyaltyCard } from './LoyaltyCard';

export function PatientDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const { mode } = useIntegrations();
  const { branchId } = useBranch();
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const patient = useAsync(() => get<PatientDetail>(`/patients/${id}`), [id]);
  const appts = useAsync(() => (can('appointment:read') ? get<Appointment[]>('/appointments', { patientId: id, limit: 20 }) : Promise.resolve([] as Appointment[])), [id]);
  const dentists = useAsync(() => (creating && branchId ? get<{ userId: string; name: string }[]>('/agenda/dentists', { branchId }) : Promise.resolve([])), [creating, branchId]);
  const p = patient.data;

  if (patient.loading && !p) return <Loading rows={4} />;
  if (patient.error != null) return <ErrorState error={patient.error} onRetry={patient.reload} />;
  if (!p) return null;
  const clinical = can('clinical:read') || can('clinical:view');
  const viewOnly = !can('clinical:write');
  const document = p.identifiers[0] ? `${p.identifiers[0].type} ${p.identifiers[0].number}` : 'Sin documento';

  return (
    <>
      <p><Link to="/pacientes">‹ Pacientes</Link></p>
      <div className="page-head">
        <div>
          <h1>{p.fullName}</h1>
          <p className="muted tabular">{document} · {p.age ?? '—'} años · Cel. {mobileFmt(p.primaryMobile)}</p>
          <div className="chip-row" style={{ marginTop: 'var(--space-3)' }}>
            <Badge tone={p.status === 'ACTIVE' ? 'success' : 'neutral'}>{p.status === 'ACTIVE' ? 'Activo' : 'Inactivo'}</Badge>
            {p.isMinor && <Badge tone="warning">Menor de edad</Badge>}
          </div>
        </div>
        {can('appointment:manage') && branchId && p.status === 'ACTIVE' && (
          <Button variant="primary" icon={<Plus size={18} aria-hidden="true" />} onClick={() => setCreating(true)}>Nueva cita</Button>
        )}
      </div>

      <div className="grid-2">
        <section className="card" aria-labelledby="ident-h">
          <h2 id="ident-h" className="h3" style={{ marginBottom: 'var(--space-5)' }}>Identificación</h2>
          <dl className="facts">
            <dt>Documento</dt><dd className="tabular">{document}</dd>
            <dt>Nacimiento</dt><dd>{p.birthDate ? fmtDate(p.birthDate) : '—'}</dd>
            <dt>Celular</dt><dd className="tabular">{mobileFmt(p.primaryMobile)}</dd>
          </dl>
        </section>

        <section className="card" aria-labelledby="appts-h">
          <h2 id="appts-h" className="h3" style={{ marginBottom: 'var(--space-5)' }}>Citas</h2>
          {appts.loading && <Loading rows={2} />}
          {appts.error != null && <ErrorState error={appts.error} onRetry={appts.reload} />}
          {appts.data && appts.data.length === 0 && <EmptyState title="Sin citas registradas">Reserve una cita con «Nueva cita».</EmptyState>}
          {appts.data && appts.data.length > 0 && (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 'var(--space-4)' }}>
              {appts.data.map((a) => (
                <li key={a.id}>
                  <button type="button" className="btn btn-tertiary" style={{ width: '100%', justifyContent: 'space-between', whiteSpace: 'normal', textAlign: 'left' }} onClick={() => setOpenId(a.id)}>
                    <span><strong>{fmtLongDay(dayOf(a.startsAt))}</strong> · <span className="tabular">{timeOf(a.startsAt)}</span><br /><span className="caption muted">{a.service.name} · {a.dentist.name}</span></span>
                    <StatusBadge status={a.status} label={a.statusLabel} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {mode === 'mock' && can('loyalty:read') && <LoyaltyCard patientId={id} />}

      {clinical ? <ClinicalCard patientId={id} viewOnly={viewOnly} /> : (
        <Alert tone="info" title="Información clínica">
          Su rol no incluye la historia clínica, la evolución ni el odontograma.
        </Alert>
      )}

      {openId && <AppointmentDrawer id={openId} onClose={() => setOpenId(null)} onChanged={appts.reload} />}
      {creating && branchId && dentists.data && <NewAppointmentDrawer branchId={branchId} dentists={dentists.data} defaultDate={dayOf(new Date().toISOString())} defaultPatient={p} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); appts.reload(); }} />}
    </>
  );
}

function ClinicalCard({ patientId, viewOnly }: { patientId: string; viewOnly: boolean }) {
  const visits = useAsync(() => get<VisitRow[]>(`/patients/${patientId}/clinical/visits`), [patientId]);
  const noRelation = visits.error instanceof ApiError && visits.error.status === 403;
  return (
    <section className="card" aria-labelledby="clin-h" style={{ marginTop: 'var(--space-6)' }}>
      <div className="card-head">
        <h2 id="clin-h" className="h3">Atención clínica{viewOnly && <> <Badge tone="neutral">Solo lectura</Badge></>}</h2>
        {!noRelation && <Link className="btn btn-secondary btn-sm" to={`/pacientes/${patientId}/odontograma`}>Ver odontograma</Link>}
      </div>
      {visits.loading && <Loading rows={2} />}
      {noRelation && <Alert tone="warning" title="Sin acceso clínico a este paciente" action={undefined}>No tiene una relación asistencial vigente con este paciente. Se genera al iniciar la atención desde una cita.</Alert>}
      {!noRelation && visits.error != null && <ErrorState error={visits.error} onRetry={visits.reload} />}
      {visits.data && visits.data.length === 0 && <EmptyState icon={<ShieldAlert size={32} aria-hidden="true" />} title="Todavía no hay visitas">Las visitas aparecen cuando se inicia la atención de una cita.</EmptyState>}
      {visits.data && visits.data.length > 0 && (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 'var(--space-4)' }}>
          {visits.data.map((v) => (
            <li key={v.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-4)', alignItems: 'center', flexWrap: 'wrap' }}>
              <span><strong>Visita {v.visitNumber}</strong> · {fmtDate(v.startedAt)}<br /><span className="caption muted">{v.reason ?? 'Sin motivo registrado'}</span></span>
              <span className="chip-row"><Badge tone={v.status === 'OPEN' ? 'info' : v.status === 'CLOSED' ? 'success' : 'neutral'}>{v.status === 'OPEN' ? 'Abierta' : v.status === 'CLOSED' ? 'Cerrada' : 'Cancelada'}</Badge>
                <Link className="btn btn-secondary btn-sm" to={`/pacientes/${patientId}/atencion/${v.id}`}><ClipboardList size={16} aria-hidden="true" />Abrir ficha</Link></span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
