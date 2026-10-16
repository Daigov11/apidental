import { useState } from 'react';
import { Pencil } from 'lucide-react';
import { get, post } from '../../api/client';
import type { Dentition, OdontogramSpecLite, OdontogramView } from '../../api/types';
import { useAsync } from '../../lib/useAsync';
import { Button } from '../../ui/Button';
import { Alert, EmptyState, Loading, errorText, useToast } from '../../ui/feedback';
import { ReasonDialog } from '../../ui/overlays';
import { OdontogramEditor } from './OdontogramEditor';
import { OdontogramFigure } from './OdontogramFigure';
import muela from '../../assets/brand/muela.png';

/** Carga el odontograma del paciente y sus acciones de inicio; lo comparten la página del odontograma y la ficha de atención. */
export function useOdontogram(patientId: string, onChanged?: () => void) {
  const toast = useToast();
  const view = useAsync(() => get<OdontogramView>(`/patients/${patientId}/clinical/odontogram`), [patientId]);
  const spec = useAsync(() => get<OdontogramSpecLite>('/clinical/odontogram/spec'), []);
  const [starting, setStarting] = useState(false);
  const official = view.data?.official ?? null;
  const start = async (purpose?: 'UPDATE', reason?: string, kind?: 'CORRECTION' | 'RECTIFICATION') => {
    setStarting(true);
    try {
      await post(`/patients/${patientId}/clinical/odontogram/draft`, { purpose: kind ?? purpose, ...(reason ? { reason } : {}), ...(!official ? { dentition: 'PERMANENT' } : {}) });
      view.reload();
      onChanged?.();
    } catch (e) { toast.error(errorText(e)); }
    finally { setStarting(false); }
  };
  const finished = (msg: string) => { toast.success(msg); view.reload(); onChanged?.(); };
  return { view, spec, official, starting, start, finished };
}
export type OdontogramState = ReturnType<typeof useOdontogram>;

/**
 * Lienzo del odontograma: editor del borrador, botones de inicio, figura del vigente y avisos.
 * `embedded` lo adapta a la ficha de atención (sin el aviso de solo lectura de la página completa).
 */
export function OdontogramCanvas({ patientId, od, canWrite, embedded = false }: { patientId: string; od: OdontogramState; canWrite: boolean; embedded?: boolean }) {
  const { view, spec, official, starting, start, finished } = od;
  const [correcting, setCorrecting] = useState<'CORRECTION' | 'RECTIFICATION' | null>(null);
  return (
    <>
      {view.data?.draft && view.data.draftIsMine && spec.data?.layout && (
        <OdontogramEditor key={view.data.draft.version} patientId={patientId} draft={view.data.draft} spec={spec.data} onFinished={finished} />
      )}
      {view.data?.draft && !view.data.draftIsMine && <Alert tone="warning">Hay un borrador en curso de otro odontólogo.</Alert>}
      {!canWrite && !embedded && <Alert tone="info">Vista de solo lectura: este perfil puede ver el odontograma, no editarlo.</Alert>}
      {canWrite && !view.data?.draft && (
        <div className="toolbar" style={{ gap: 'var(--space-4)' }}>
          <Button variant="primary" icon={<Pencil size={18} aria-hidden="true" />} loading={starting} loadingText="Abriendo…" onClick={() => void start(official ? 'UPDATE' : undefined)}>
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
      {!official && !view.data?.draft && (embedded
        ? <p className="muted">Todavía no hay un odontograma guardado.{canWrite ? ' Use «Iniciar odontograma» para registrarlo durante la atención.' : ''}</p>
        : <EmptyState icon={<img className="empty-art" src={muela} alt="" aria-hidden="true" />} title="Todavía no hay un odontograma guardado">{canWrite ? 'Use «Iniciar odontograma» para registrarlo durante la atención.' : 'El odontólogo lo registra durante la atención.'}</EmptyState>)}
      {official && !view.data?.draft && (
        <div className="odonto-figure odonto-figure-edit">
          {spec.data?.layout && official.data
            ? <OdontogramFigure spec={spec.data} dentition={official.dentition as Dentition} teeth={official.data.teeth} selected={null} />
            : official.contentHidden ? <p className="muted">El detalle no está disponible para su perfil.</p> : <Loading rows={2} label="Preparando el dibujo" />}
        </div>
      )}
    </>
  );
}
