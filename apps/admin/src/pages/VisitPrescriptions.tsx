import { useState } from 'react';
import { Pill, Plus } from 'lucide-react';
import { get } from '../api/client';
import type { Prescription } from '../api/types';
import { fmtDateTime } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import { Button } from '../ui/Button';
import { ErrorState, Loading, useToast } from '../ui/feedback';
import { PrescriptionDrawer } from './Prescriptions';

/**
 * Receta desde la atención (si la requiere): se emite ligada a esta visita. En caja aparece como sugerencia y se cobra SOLO si el
 * paciente lleva lo recetado (es opcional).
 */
export function VisitPrescriptionsCard({ patientId, patientName, visitId, editable }: { patientId: string; patientName: string; visitId: string; editable: boolean }) {
  const toast = useToast();
  const list = useAsync(() => get<Prescription[]>(`/patients/${patientId}/prescriptions`).catch(() => [] as Prescription[]), [patientId, visitId]);
  const [open, setOpen] = useState(false);
  const mine = (list.data ?? []).filter((r) => r.visitId === visitId && r.status === 'ACTIVE');
  return (
    <section className="card" aria-labelledby="vrx-h">
      <div className="card-head">
        <h2 id="vrx-h" className="h3">Receta</h2>
        {editable && <Button size="sm" icon={<Plus size={16} aria-hidden="true" />} onClick={() => setOpen(true)}>Emitir receta</Button>}
      </div>
      {list.loading && !list.data && <Loading rows={1} />}
      {list.error != null && <ErrorState error={list.error} onRetry={list.reload} />}
      {list.data && mine.length === 0 && <p className="muted">{editable ? 'Si el paciente lo requiere, emita una receta. En caja se cobra solo si la compra.' : 'Sin recetas en esta atención.'}</p>}
      {mine.length > 0 && (
        <ul className="context-list" aria-label="Recetas de esta atención">
          {mine.map((r) => (
            <li key={r.id}>
              <Pill size={16} aria-hidden="true" /> <strong className="tabular">{r.number}</strong> · {r.items.map((i) => i.medication).join(', ')}
              <span className="caption muted"> · {fmtDateTime(r.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}
      {mine.length > 0 && <p className="caption muted">En caja aparece como sugerencia: el paciente decide si la compra.</p>}
      {open && (
        <PrescriptionDrawer
          patientId={patientId} patientName={patientName} visitId={visitId}
          onClose={() => setOpen(false)}
          onSaved={() => { setOpen(false); list.reload(); toast.success('Receta emitida.'); }}
        />
      )}
    </section>
  );
}
