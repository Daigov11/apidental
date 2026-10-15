import { Link } from 'react-router-dom';
import { ListChecks, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { ApiError, get, post } from '../api/client';
import type { BillingDocument, OutboxItem } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { fmtDateTime } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import { Button } from '../ui/Button';
import { Badge, DocStatusBadge, EmptyState, ErrorState, Loading, SimulatedTag, errorText, useToast } from '../ui/feedback';

const TONE = { PENDING: 'info', DONE: 'success', FAILED: 'danger', SKIPPED: 'neutral' } as const;

/** Comprobantes simulados, cola de integraciones (outbox) y conciliación. */
export function DocumentsPage() {
  const { can } = useAuth();
  const toast = useToast();
  const docs = useAsync(() => get<BillingDocument[]>('/billing/documents', { limit: 50 }), []);
  const queue = useAsync(() => get<OutboxItem[]>('/billing/outbox', { limit: 30 }), []);
  const [busy, setBusy] = useState<string | null>(null);
  const reload = () => { docs.reload(); queue.reload(); };
  const run = async (key: string, fn: () => Promise<unknown>, ok: (r: never) => string) => {
    setBusy(key);
    try { const r = await fn(); toast.success(ok(r as never)); } catch (e) { toast.error(e instanceof ApiError ? errorText(e) : 'No se pudo completar.'); }
    finally { setBusy(null); reload(); }
  };
  const manage = can('billing:manage');
  return (
    <>
      <div className="page-head"><h1>Comprobantes</h1><SimulatedTag /></div>
      <p className="muted" style={{ marginBottom: 'var(--space-5)' }}>Comprobantes de demostración: ninguno se envía a SUNAT. La cola entrega lo pendiente al proveedor simulado y la conciliación consulta su estado real.</p>
      {manage && (
        <div className="chip-row" style={{ marginBottom: 'var(--space-6)' }}>
          <Button icon={<ListChecks size={18} aria-hidden="true" />} loading={busy === 'process'} loadingText="Procesando…" onClick={() => void run('process', () => post<{ processed: number; done: number; skipped: number }>('/billing/outbox/process'), (r: { processed: number; done: number; skipped: number }) => `Cola procesada: ${r.processed} mensaje(s), ${r.done} entregado(s), ${r.skipped} omitido(s).`)}>Procesar cola</Button>
          <Button icon={<RefreshCw size={18} aria-hidden="true" />} loading={busy === 'reconcile'} loadingText="Conciliando…" onClick={() => void run('reconcile', () => post<{ checked: number }>('/billing/reconcile'), (r: { checked: number }) => `Conciliación: ${r.checked} comprobante(s) revisado(s).`)}>Conciliar pendientes</Button>
        </div>
      )}

      <section aria-labelledby="docs-h">
        <h2 id="docs-h" className="h2" style={{ marginBottom: 'var(--space-4)' }}>Lista de comprobantes</h2>
        {docs.loading && !docs.data && <Loading rows={3} />}
        {docs.error != null && <ErrorState error={docs.error} onRetry={docs.reload} />}
        {docs.data?.length === 0 && <EmptyState title="Todavía no hay comprobantes">Emítalos desde el detalle de un cobro pagado.</EmptyState>}
        {docs.data && docs.data.length > 0 && (
          <div className="table-wrap table-cards">
            <table>
              <caption className="sr-only">Comprobantes simulados</caption>
              <thead><tr><th scope="col">Número</th><th scope="col">Paciente</th><th scope="col">Concepto</th><th scope="col" className="num">Total</th><th scope="col">Estado</th><th scope="col">Marca</th></tr></thead>
              <tbody>
                {docs.data.map((d) => (
                  <tr key={d.id}>
                    <td data-label="Número" className="tabular"><Link className="row-link" to={`/caja/${d.chargeId}`}>{d.number}</Link></td>
                    <td data-label="Paciente">{d.patientName}</td>
                    <td data-label="Concepto">{d.description}</td>
                    <td data-label="Total" className="num">{d.amountText}</td>
                    <td data-label="Estado"><DocStatusBadge status={d.status} label={d.statusLabel} /></td>
                    <td data-label="Marca" className="caption">{d.demoMark}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="queue-h" style={{ marginTop: 'var(--space-8)' }}>
        <h2 id="queue-h" className="h2" style={{ marginBottom: 'var(--space-4)' }}>Cola de integraciones</h2>
        {queue.loading && !queue.data && <Loading rows={2} />}
        {queue.error != null && <ErrorState error={queue.error} onRetry={queue.reload} />}
        {queue.data?.length === 0 && <EmptyState title="La cola está vacía" />}
        {queue.data && queue.data.length > 0 && (
          <div className="table-wrap table-cards">
            <table>
              <caption className="sr-only">Mensajes de la cola de integraciones</caption>
              <thead><tr><th scope="col">Fecha</th><th scope="col">Tipo</th><th scope="col">Referencia</th><th scope="col">Estado</th><th scope="col">Intentos</th><th scope="col">Nota</th></tr></thead>
              <tbody>
                {queue.data.map((q) => (
                  <tr key={q.id}>
                    <td data-label="Fecha" className="tabular">{fmtDateTime(q.createdAt)}</td>
                    <td data-label="Tipo">{q.kindLabel}</td>
                    <td data-label="Referencia">{q.reference}</td>
                    <td data-label="Estado"><Badge tone={TONE[q.status]}>{q.statusLabel}</Badge></td>
                    <td data-label="Intentos" className="num">{q.attempts}</td>
                    <td data-label="Nota">{q.note ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
