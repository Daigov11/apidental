import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { get } from '../api/client';
import type { Calendar, CalendarAppointment } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { addDays, dayOf, fmtLongDay, fmtShortDay, limaDate, minuteOfDay, mondayOf, timeOf } from '../lib/format';
import { useBranch } from '../lib/branch';
import { useAsync } from '../lib/useAsync';
import { Button } from '../ui/Button';
import { SelectField, TextField } from '../ui/fields';
import { EmptyState, ErrorState, Loading, StatusBadge } from '../ui/feedback';
import { AppointmentDrawer, NewAppointmentDrawer } from './AppointmentPanels';

const HOUR_PX = 96;
const px = (minute: number, start: number) => ((minute - start) / 60) * HOUR_PX;

export function AgendaPage() {
  const { can } = useAuth();
  const { branches, branchId, setBranchId } = useBranch();
  const [view, setView] = useState<'day' | 'week'>('day');
  const [date, setDate] = useState(limaDate());
  const [dentistId, setDentistId] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const from = view === 'week' ? mondayOf(date) : date;
  const to = view === 'week' ? addDays(from, 6) : date;
  const cal = useAsync(
    (signal) => (branchId ? get<Calendar>('/agenda/calendar', { branchId, from, to, dentistUserId: dentistId || undefined }, signal) : Promise.resolve(null)),
    [branchId, from, to, dentistId],
  );
  const step = view === 'week' ? 7 : 1;

  return (
    <>
      <div className="page-head">
        <h1>Agenda</h1>
        {can('appointment:manage') && branchId && (
          <Button variant="primary" icon={<Plus size={18} aria-hidden="true" />} onClick={() => setCreating(true)}>Nueva cita</Button>
        )}
      </div>

      <div className="toolbar" role="group" aria-label="Filtros de la agenda">
        <div className="chip-row" style={{ alignItems: 'center' }}>
          <Button size="sm" aria-label="Día anterior" icon={<ChevronLeft size={18} aria-hidden="true" />} onClick={() => setDate(addDays(date, -step))}>{''}</Button>
          <Button size="sm" onClick={() => setDate(limaDate())}>Hoy</Button>
          <Button size="sm" aria-label="Día siguiente" icon={<ChevronRight size={18} aria-hidden="true" />} onClick={() => setDate(addDays(date, step))}>{''}</Button>
        </div>
        <TextField label="Fecha" type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
        <SelectField label="Vista" value={view} onChange={(e) => setView(e.target.value as 'day' | 'week')}>
          <option value="day">Día</option>
          <option value="week">Semana (lista)</option>
        </SelectField>
        {branches.length > 1 && (
          <SelectField label="Sede" value={branchId ?? ''} onChange={(e) => setBranchId(e.target.value)}>
            {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </SelectField>
        )}
        <SelectField label="Odontólogo" value={dentistId} onChange={(e) => setDentistId(e.target.value)}>
          <option value="">Todos</option>
          {cal.data?.dentists.map((d) => <option key={d.userId} value={d.userId}>{d.name}</option>)}
        </SelectField>
      </div>
      <h2 className="h3" style={{ marginBottom: 'var(--space-4)' }} aria-live="polite">
        {view === 'day' ? fmtLongDay(date) : `Semana del ${fmtShortDay(from)} al ${fmtShortDay(to)}`}
      </h2>

      {!branchId && <EmptyState title="No hay una sede disponible" >Su usuario no tiene sedes visibles para la agenda.</EmptyState>}
      {branchId && cal.loading && !cal.data && <Loading label="Cargando la agenda" rows={4} />}
      {cal.error != null && <ErrorState error={cal.error} onRetry={cal.reload} />}
      {cal.data && view === 'day' && <DayGrid cal={cal.data} date={date} onOpen={setOpenId} />}
      {cal.data && view === 'week' && <WeekList cal={cal.data} onOpen={setOpenId} />}

      {openId && <AppointmentDrawer id={openId} onClose={() => setOpenId(null)} onChanged={cal.reload} />}
      {creating && branchId && cal.data && (
        <NewAppointmentDrawer branchId={branchId} dentists={cal.data.dentists} defaultDate={date} defaultDentist={dentistId || undefined} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); cal.reload(); }} />
      )}
    </>
  );
}

function DayGrid({ cal, date, onOpen }: { cal: Calendar; date: string; onOpen: (id: string) => void }) {
  const dentists = cal.dentists.filter((d) => cal.windows.some((w) => w.dentistUserId === d.userId) || cal.appointments.some((a) => a.dentistUserId === d.userId));
  const { start, end } = useMemo(() => {
    const mins = [...cal.windows.map((w) => minuteOfDay(w.startsAt)), ...cal.appointments.map((a) => minuteOfDay(a.startsAt))];
    const maxs = [...cal.windows.map((w) => minuteOfDay(w.endsAt) || 1440), ...cal.appointments.map((a) => minuteOfDay(a.endsAt) || 1440)];
    return { start: Math.floor(Math.min(8 * 60, ...mins) / 60) * 60, end: Math.ceil(Math.max(18 * 60, ...maxs) / 60) * 60 };
  }, [cal]);
  const gridRef = useRef<HTMLDivElement>(null);
  const firstWork = Math.min(...cal.windows.map((w) => minuteOfDay(w.startsAt)), ...cal.appointments.map((a) => minuteOfDay(a.startsAt)), 24 * 60);
  // Al abrir el día se muestra desde el inicio de la jornada (no desde la hora más temprana del día).
  useEffect(() => {
    if (gridRef.current && firstWork < 24 * 60) gridRef.current.scrollTop = Math.max(0, px(firstWork, start) - HOUR_PX / 2);
  }, [firstWork, start, date]);
  if (dentists.length === 0) return <EmptyState title="No hay horarios de atención este día">Configure el horario de los odontólogos o elija otra fecha.</EmptyState>;
  const hours = Array.from({ length: (end - start) / 60 + 1 }, (_, i) => start + i * 60);
  const height = ((end - start) / 60) * HOUR_PX;
  const room = (id: string) => cal.rooms.find((r) => r.id === id)?.name;
  return (
    <div ref={gridRef} className="agenda-grid" style={{ ['--cols' as string]: dentists.length, ['--hour-h' as string]: `${HOUR_PX}px` }} role="group" aria-label={`Agenda del ${fmtLongDay(date)}`}>
      <div className="agenda-head" aria-hidden="true">Hora</div>
      {dentists.map((d) => <div key={d.userId} className="agenda-head">{d.name}</div>)}
      <div className="agenda-hours" style={{ height }} aria-hidden="true">
        {hours.map((h) => <span key={h} className="agenda-hour" style={{ top: px(h, start) }}>{String(h / 60).padStart(2, '0')}:00</span>)}
      </div>
      {dentists.map((d) => {
        const wins = cal.windows.filter((w) => w.dentistUserId === d.userId);
        return (
          <div key={d.userId} className="agenda-col" style={{ height }}>
            <div className="agenda-off" style={{ top: 0, height }} aria-hidden="true" />
            {wins.map((w) => <div key={w.startsAt} style={{ position: 'absolute', left: 0, right: 0, top: px(minuteOfDay(w.startsAt), start), height: px(minuteOfDay(w.endsAt) || 1440, start) - px(minuteOfDay(w.startsAt), start), background: 'var(--bg-surface)' }} aria-hidden="true" />)}
            {cal.blocks.filter((b) => b.dentistUserId === d.userId || b.dentistUserId === null).map((b) => (
              <div key={b.id} className="agenda-block-off" style={{ top: px(Math.max(minuteOfDay(b.startsAt), start), start), height: Math.max(20, px(Math.min(minuteOfDay(b.endsAt) || 1440, end), start) - px(Math.max(minuteOfDay(b.startsAt), start), start)) }}>
                No disponible · {b.reason}
              </div>
            ))}
            {cal.appointments.filter((a) => a.dentistUserId === d.userId && a.status !== 'CANCELLED').map((a) => <Block key={a.id} a={a} start={start} room={room(a.roomId)} onOpen={onOpen} />)}
          </div>
        );
      })}
    </div>
  );
}

function Block({ a, start, room, onOpen }: { a: CalendarAppointment; start: number; room?: string; onOpen: (id: string) => void }) {
  const top = px(minuteOfDay(a.startsAt), start);
  const height = Math.max(26, px(minuteOfDay(a.endsAt) || 1440, start) - top);
  const compact = height < 46; // en bloques cortos todo va en una línea para que no se corte
  const detail = `${a.service}${room ? ` · ${room}` : ''} · ${a.statusLabel}`;
  return (
    <button type="button" className={`appt-block appt-${a.status}${compact ? ' is-compact' : ''}`} style={{ top, height }} onClick={() => onOpen(a.id)}
      title={`${timeOf(a.startsAt)} · ${a.patient.name} — ${detail}`}
      aria-label={`${timeOf(a.startsAt)}, ${a.patient.name}, ${a.service}, ${a.statusLabel}`}>
      {compact
        ? <strong>{timeOf(a.startsAt)} · {a.patient.name} <span className="appt-detail">— {detail}</span></strong>
        : <><strong>{timeOf(a.startsAt)} · {a.patient.name}</strong><span>{detail}</span></>}
    </button>
  );
}

/** Vista equivalente en lista (accesible): citas por día. */
function WeekList({ cal, onOpen }: { cal: Calendar; onOpen: (id: string) => void }) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(cal.from, i));
  const dentist = (id: string) => cal.dentists.find((d) => d.userId === id)?.name ?? '';
  return (
    <div className="week-grid">
      {days.map((d) => {
        const list = cal.appointments.filter((a) => dayOf(a.startsAt) === d);
        return (
          <section key={d} className="day-col" aria-label={fmtLongDay(d)}>
            <h3 className="h3">{fmtShortDay(d)}</h3>
            {list.length === 0 ? <p className="muted caption" style={{ marginTop: 'var(--space-3)' }}>Sin citas</p> : (
              <ul>
                {list.map((a) => (
                  <li key={a.id}>
                    <button type="button" className={`appt-${a.status}`} onClick={() => onOpen(a.id)}>
                      <strong className="tabular">{timeOf(a.startsAt)}</strong> {a.patient.name}
                      <span className="caption muted" style={{ display: 'block' }}>{a.service} · {dentist(a.dentistUserId)}</span>
                      <StatusBadge status={a.status} label={a.statusLabel} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
