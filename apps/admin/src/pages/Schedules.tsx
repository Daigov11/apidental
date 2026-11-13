import { useState } from 'react';
import { Plus, RefreshCw, Trash2 } from 'lucide-react';
import { get, post, put } from '../api/client';
import { useBranch } from '../lib/branch';
import { useAsync } from '../lib/useAsync';
import { Button } from '../ui/Button';
import { SelectField, TextField } from '../ui/fields';
import { Alert, Badge, EmptyState, ErrorState, Loading, errorText, useToast } from '../ui/feedback';
import { Dialog, ReasonDialog } from '../ui/overlays';

interface Dentist { userId: string; name: string; specialties: { id: string; name: string }[] }
interface Rule { id: string; branchId: string; dentistUserId: string; weekday: number; weekdayLabel: string; start: string; end: string; validFrom: string; validUntil: string | null }
interface Specialty { id: string; name: string; active: boolean }

const DAYS = [
  { n: 1, label: 'Lunes' }, { n: 2, label: 'Martes' }, { n: 3, label: 'Miércoles' }, { n: 4, label: 'Jueves' },
  { n: 5, label: 'Viernes' }, { n: 6, label: 'Sábado' }, { n: 7, label: 'Domingo' },
];

/** Horario de trabajo de cada odontólogo (qué días y a qué horas atiende) y sus especialidades: definen cuándo se le puede agendar. */
export function SchedulesPage() {
  const toast = useToast();
  const { branches, branchId, setBranchId } = useBranch();
  const dentists = useAsync(() => (branchId ? get<Dentist[]>('/agenda/dentists', { branchId }) : Promise.resolve([] as Dentist[])), [branchId]);
  const rules = useAsync(() => (branchId ? get<Rule[]>('/agenda/schedules', { branchId }) : Promise.resolve([] as Rule[])), [branchId]);
  const specialties = useAsync(() => get<Specialty[]>('/agenda/specialties'), []);
  const [adding, setAdding] = useState<Dentist | null>(null);
  const [specsOf, setSpecsOf] = useState<Dentist | null>(null);
  const [removing, setRemoving] = useState<Rule | null>(null);
  const reload = () => { dentists.reload(); rules.reload(); };

  return (
    <>
      <div className="page-head">
        <div><h1>Horarios</h1><p className="muted">Qué días y a qué horas atiende cada odontólogo. Solo se le pueden agendar citas dentro de su horario.</p></div>
        <Button size="sm" icon={<RefreshCw size={16} aria-hidden="true" />} onClick={reload}>Actualizar</Button>
      </div>
      {branches.length > 1 && (
        <div style={{ maxWidth: 320 }}>
          <SelectField label="Sede" value={branchId ?? ''} onChange={(e) => setBranchId(e.target.value)}>
            {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </SelectField>
        </div>
      )}
      {(dentists.loading || rules.loading) && !dentists.data && <Loading rows={3} />}
      {dentists.error != null && <ErrorState error={dentists.error} onRetry={reload} />}
      {dentists.data?.length === 0 && <EmptyState title="No hay odontólogos en esta sede">Cree usuarios con el rol Odontólogo en «Usuarios».</EmptyState>}
      {dentists.data?.map((d) => {
        const mine = (rules.data ?? []).filter((r) => r.dentistUserId === d.userId);
        return (
          <section key={d.userId} className="card" aria-labelledby={`dn-${d.userId}`} style={{ marginTop: 'var(--space-5)' }}>
            <div className="card-head">
              <h2 id={`dn-${d.userId}`} className="h3">{d.name}</h2>
              <div className="chip-row">
                <Button size="sm" onClick={() => setSpecsOf(d)}>Especialidades</Button>
                <Button size="sm" variant="primary" icon={<Plus size={16} aria-hidden="true" />} onClick={() => setAdding(d)}>Agregar horario</Button>
              </div>
            </div>
            <p className="caption">
              {d.specialties.length > 0 ? d.specialties.map((s) => <Badge key={s.id} tone="neutral">{s.name}</Badge>) : <Badge tone="warning">Sin especialidad: no se le pueden agendar servicios</Badge>}
            </p>
            {mine.length === 0 ? <p className="muted">Sin horario: no se le pueden agendar citas.</p> : (
              <div className="table-wrap table-cards">
                <table>
                  <caption className="sr-only">Horario de {d.name}</caption>
                  <thead><tr><th scope="col">Día</th><th scope="col">Desde</th><th scope="col">Hasta</th><th scope="col">Acciones</th></tr></thead>
                  <tbody>
                    {mine.map((r) => (
                      <tr key={r.id}>
                        <td data-label="Día">{r.weekdayLabel}</td>
                        <td data-label="Desde" className="tabular">{r.start}</td>
                        <td data-label="Hasta" className="tabular">{r.end}</td>
                        <td data-label="Acciones"><Button size="sm" variant="tertiary" icon={<Trash2 size={16} aria-hidden="true" />} aria-label={`Quitar el horario del ${r.weekdayLabel} de ${r.start} a ${r.end}`} onClick={() => setRemoving(r)}>Quitar</Button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        );
      })}

      {adding && branchId && <AddScheduleDialog dentist={adding} branchId={branchId} onClose={() => setAdding(null)} onDone={(n) => { setAdding(null); rules.reload(); toast.success(n === 1 ? 'Horario agregado.' : `${n} horarios agregados.`); }} />}
      {specsOf && <SpecialtiesDialog dentist={specsOf} all={(specialties.data ?? []).filter((s) => s.active)} onClose={() => setSpecsOf(null)} onDone={() => { setSpecsOf(null); dentists.reload(); toast.success('Especialidades guardadas.'); }} />}
      {removing && (
        <ReasonDialog
          title="Quitar horario" confirmLabel="Quitar" danger example="Ya no atiende ese día"
          explain={`Se quitará el horario del ${removing.weekdayLabel} de ${removing.start} a ${removing.end}. Las citas ya agendadas no se cancelan.`}
          onClose={() => setRemoving(null)}
          onConfirm={async (reason) => { await post(`/agenda/schedules/${removing.id}/deactivate`, { reason }); setRemoving(null); rules.reload(); toast.success('Horario quitado.'); }}
        />
      )}
    </>
  );
}

function AddScheduleDialog({ dentist, branchId, onClose, onDone }: { dentist: Dentist; branchId: string; onClose: () => void; onDone: (n: number) => void }) {
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [start, setStart] = useState('09:00');
  const [end, setEnd] = useState('18:00');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invalid = days.length === 0 || !/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end) || start >= end;
  const submit = async () => {
    if (invalid || busy) return;
    setBusy(true); setError(null);
    const failed: string[] = [];
    let ok = 0;
    for (const weekday of [...days].sort()) {
      try { await post('/agenda/schedules', { branchId, dentistUserId: dentist.userId, weekday, start, end }); ok += 1; }
      catch (e) { failed.push(`${DAYS.find((d) => d.n === weekday)!.label}: ${errorText(e)}`); }
    }
    setBusy(false);
    if (failed.length === 0) onDone(ok);
    else setError(`${ok > 0 ? `Se agregaron ${ok}. ` : ''}No se pudo: ${failed.join(' · ')}`);
  };
  return (
    <Dialog title={`Agregar horario · ${dentist.name}`} onClose={onClose} footer={<><Button onClick={onClose}>Cerrar</Button><Button variant="primary" disabled={invalid} loading={busy} loadingText="Guardando…" onClick={() => void submit()}>Agregar</Button></>}>
      {error && <Alert tone="danger">{error}</Alert>}
      <fieldset style={{ border: 0, padding: 0 }}>
        <legend className="h4">Días</legend>
        <div className="chip-row">
          {DAYS.map((d) => (
            <label key={d.n} className="check" style={{ display: 'inline-flex', gap: 'var(--space-2)', alignItems: 'center' }}>
              <input type="checkbox" checked={days.includes(d.n)} onChange={(e) => setDays((all) => (e.target.checked ? [...all, d.n] : all.filter((x) => x !== d.n)))} />
              {d.label}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="row-2">
        <TextField label="Desde" type="time" step={300} value={start} onChange={(e) => setStart(e.target.value)} />
        <TextField label="Hasta" type="time" step={300} value={end} onChange={(e) => setEnd(e.target.value)} />
      </div>
      <p className="caption muted">Para un horario partido (por ejemplo 09:00–13:00 y 15:00–19:00), agregue dos horarios.</p>
    </Dialog>
  );
}

function SpecialtiesDialog({ dentist, all, onClose, onDone }: { dentist: Dentist; all: Specialty[]; onClose: () => void; onDone: () => void }) {
  const [ids, setIds] = useState<string[]>(dentist.specialties.map((s) => s.id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true); setError(null);
    try { await put(`/agenda/dentists/${dentist.userId}/specialties`, { specialtyIds: ids }); onDone(); }
    catch (e) { setError(errorText(e)); setBusy(false); }
  };
  return (
    <Dialog title={`Especialidades · ${dentist.name}`} onClose={onClose} footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" loading={busy} loadingText="Guardando…" onClick={() => void submit()}>Guardar</Button></>}>
      <p className="muted">Cada servicio de la agenda pertenece a una especialidad: el odontólogo solo puede recibir citas de los servicios de sus especialidades.</p>
      {error && <Alert tone="danger">{error}</Alert>}
      {all.length === 0 && <Alert tone="warning">No hay especialidades configuradas en la clínica.</Alert>}
      {all.map((s) => (
        <label key={s.id} className="check" style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
          <input type="checkbox" checked={ids.includes(s.id)} onChange={(e) => setIds((cur) => (e.target.checked ? [...cur, s.id] : cur.filter((x) => x !== s.id)))} />
          {s.name}
        </label>
      ))}
    </Dialog>
  );
}
