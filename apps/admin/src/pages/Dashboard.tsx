import { Link } from 'react-router-dom';
import { get } from '../api/client';
import type { Appointment } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { fmtLongDay, limaDate, timeOf } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import { Alert, EmptyState, ErrorState, Loading, StatusBadge } from '../ui/feedback';
import { CalendarDays } from 'lucide-react';

export function DashboardPage() {
  const { me, can } = useAuth();
  const today = limaDate();
  const canSee = can('appointment:read');
  const list = useAsync(() => (canSee ? get<Appointment[]>('/appointments', { from: today, to: today, limit: 100 }) : Promise.resolve([] as Appointment[])), [today, canSee]);
  const appts = (list.data ?? []).filter((a) => a.status !== 'CANCELLED');
  const total = appts.length;
  const toConfirm = appts.filter((a) => a.status === 'RESERVED').length;
  const done = appts.filter((a) => a.status === 'ATTENDED').length;
  const noShow = appts.filter((a) => a.status === 'NO_SHOW').length;
  const upcoming = appts.filter((a) => a.status === 'RESERVED' || a.status === 'CONFIRMED');

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Hoy</h1>
          <p className="muted">Hola, {me?.user.firstName} · {fmtLongDay(today)}</p>
        </div>
      </div>
      {!me?.context?.clinic && <Alert tone="info" title="Está en la administración de la plataforma">Para trabajar con una clínica, use «Cambiar sede» y elija una clínica.</Alert>}
      {canSee && (
        <>
          <div className="grid-stats" aria-label="Resumen del día">
            <div className="card stat"><span className="muted">Citas de hoy</span><span className="stat-value">{total}</span><span className="caption muted">{done} atendidas</span></div>
            <div className="card stat"><span className="muted">Por confirmar</span><span className="stat-value">{toConfirm}</span><Link to="/agenda">Ver agenda</Link></div>
            <div className="card stat"><span className="muted">Ausencias</span><span className="stat-value">{noShow}</span><span className="caption muted">de hoy</span></div>
          </div>
          <section className="card" aria-labelledby="next-h">
            <div className="card-head"><h2 id="next-h" className="h3">Próximas citas</h2><Link to="/agenda">Ver agenda</Link></div>
            {list.loading && <Loading rows={3} />}
            {list.error != null && <ErrorState error={list.error} onRetry={list.reload} />}
            {!list.loading && !list.error && upcoming.length === 0 && <EmptyState icon={<CalendarDays size={32} aria-hidden="true" />} title="No quedan citas por atender hoy">Puede reservar una cita desde la agenda.</EmptyState>}
            {upcoming.length > 0 && (
              <div className="table-wrap table-cards">
                <table>
                  <caption className="sr-only">Citas de hoy pendientes de atención</caption>
                  <thead><tr><th scope="col">Hora</th><th scope="col">Paciente</th><th scope="col">Servicio</th><th scope="col">Odontólogo</th><th scope="col">Estado</th></tr></thead>
                  <tbody>
                    {upcoming.map((a) => (
                      <tr key={a.id}>
                        <td data-label="Hora" className="tabular">{timeOf(a.startsAt)}</td>
                        <td data-label="Paciente"><Link className="row-link" to="/agenda">{a.patient.name}</Link></td>
                        <td data-label="Servicio">{a.service.name}</td>
                        <td data-label="Odontólogo">{a.dentist.name}</td>
                        <td data-label="Estado"><StatusBadge status={a.status} label={a.statusLabel} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
      {!canSee && me?.context?.clinic && <Alert tone="info">Use el menú para ir a los módulos disponibles para su rol.</Alert>}
    </>
  );
}
