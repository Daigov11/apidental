import { useState } from 'react';
import { Download, FileSpreadsheet, RefreshCw, Search } from 'lucide-react';
import { get } from '../api/client';
import type { AwSale } from '../api/types';
import { downloadFile } from '../lib/download';
import { fmtDateTime } from '../lib/format';
import { fmtMoney } from '../lib/money';
import { useAsync } from '../lib/useAsync';
import { Button } from '../ui/Button';
import { TextField } from '../ui/fields';
import { Badge, EmptyState, ErrorState, Loading, errorText, useToast } from '../ui/feedback';

const limaToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());
const monthStart = () => `${limaToday().slice(0, 8)}01`;
const PAGE = 50;
const DOC_TONE = { PENDING_ISSUE: 'warning', PENDING: 'info', SENT: 'success', REJECTED: 'danger', PENDING_RECONCILIATION: 'warning' } as const;

type Sale = AwSale & { discountCents?: number; payments?: { idMetodoPago: string; amountCents: number }[] };

/** Historial de ventas (comprobantes) con filtros y exportación a Excel o PDF. */
export function SalesHistoryPage() {
  const toast = useToast();
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(limaToday());
  const [text, setText] = useState('');
  const [applied, setApplied] = useState({ from: monthStart(), to: limaToday(), search: '' });
  const [page, setPage] = useState(0);
  const list = useAsync(() => get<{ items: Sale[]; total: number }>('/apiworking/sales', { limit: PAGE, offset: page * PAGE, from: applied.from || undefined, to: applied.to || undefined, search: applied.search || undefined }), [applied, page]);
  const [busy, setBusy] = useState<'xlsx' | 'pdf' | null>(null);
  const invalid = Boolean(from && to && from > to);

  const apply = () => { if (!invalid) { setPage(0); setApplied({ from, to, search: text.trim() }); } };
  const exportAs = async (format: 'xlsx' | 'pdf') => {
    setBusy(format);
    try { await downloadFile('/apiworking/sales/export', { format, from: applied.from || undefined, to: applied.to || undefined, search: applied.search || undefined }, `ventas_${applied.from || 'inicio'}_${applied.to || limaToday()}.${format}`); }
    catch (e) { toast.error(errorText(e)); }
    finally { setBusy(null); }
  };
  const items = list.data?.items ?? [];
  const counted = items.filter((s) => s.docStatus !== 'REJECTED' && !s.voidStatus);
  const pages = Math.max(1, Math.ceil((list.data?.total ?? 0) / PAGE));

  return (
    <>
      <div className="page-head">
        <div><h1>Historial de ventas</h1><p className="muted">Comprobantes registrados en Apiworking y cobros en contingencia.</p></div>
        <div className="chip-row">
          <Button icon={<FileSpreadsheet size={18} aria-hidden="true" />} loading={busy === 'xlsx'} loadingText="Generando…" onClick={() => void exportAs('xlsx')}>Exportar Excel</Button>
          <Button icon={<Download size={18} aria-hidden="true" />} loading={busy === 'pdf'} loadingText="Generando…" onClick={() => void exportAs('pdf')}>Exportar PDF</Button>
        </div>
      </div>
      <form className="chip-row" style={{ alignItems: 'flex-end' }} onSubmit={(e) => { e.preventDefault(); apply(); }} aria-label="Filtros del historial">
        <TextField label="Desde" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <TextField label="Hasta" type="date" value={to} onChange={(e) => setTo(e.target.value)} error={invalid ? '«Hasta» debe ser posterior a «Desde».' : null} />
        <div style={{ minWidth: 260 }}><TextField label="Buscar" help="Cliente, documento, número de comprobante o detalle." value={text} onChange={(e) => setText(e.target.value)} /></div>
        <Button type="submit" variant="primary" icon={<Search size={16} aria-hidden="true" />} disabled={invalid}>Filtrar</Button>
        <Button size="sm" icon={<RefreshCw size={16} aria-hidden="true" />} onClick={list.reload}>Actualizar</Button>
      </form>

      {list.loading && !list.data && <Loading rows={4} />}
      {list.error != null && <ErrorState error={list.error} onRetry={list.reload} />}
      {list.data && items.length === 0 && <EmptyState title="Sin ventas">No hay ventas con esos filtros.</EmptyState>}
      {items.length > 0 && (
        <>
          <p className="caption muted" role="status" style={{ marginTop: 'var(--space-4)' }}>
            {list.data!.total} {list.data!.total === 1 ? 'venta' : 'ventas'} · en esta página: {fmtMoney(counted.reduce((t, s) => t + s.totalCents, 0))} vendido (sin rechazadas ni anuladas)
          </p>
          <div className="table-wrap table-cards">
            <table>
              <caption className="sr-only">Historial de ventas</caption>
              <thead><tr><th scope="col">Fecha</th><th scope="col">Comprobante</th><th scope="col">Cliente</th><th scope="col">Detalle</th><th scope="col" className="num">Descuento</th><th scope="col" className="num">Total</th><th scope="col">Estado</th><th scope="col">Cobro</th></tr></thead>
              <tbody>
                {items.map((s) => (
                  <tr key={s.id}>
                    <td data-label="Fecha" className="tabular">{fmtDateTime(s.createdAt)}</td>
                    <td data-label="Comprobante" className="tabular">{s.externalNumber ?? '—'}</td>
                    <td data-label="Cliente">{s.customer.name}<br /><span className="caption muted tabular">{s.customer.docType} {s.customer.docNumber}</span></td>
                    <td data-label="Detalle">{s.description}{s.payments && s.payments.length > 1 && <><br /><span className="caption muted">Pagado con {s.payments.length} medios</span></>}</td>
                    <td data-label="Descuento" className="num">{s.discountCents ? fmtMoney(s.discountCents) : '—'}</td>
                    <td data-label="Total" className="num">{s.totalText}</td>
                    <td data-label="Estado"><Badge tone={DOC_TONE[s.docStatus]}>{s.docStatusLabel}</Badge>{s.voidStatusLabel && <><br /><Badge tone="neutral">{s.voidStatusLabel}</Badge></>}</td>
                    <td data-label="Cobro">{s.paymentStatusLabel}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <div className="chip-row" style={{ marginTop: 'var(--space-4)' }}>
              <Button size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Anterior</Button>
              <span className="caption tabular">Página {page + 1} de {pages}</span>
              <Button size="sm" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>Siguiente</Button>
            </div>
          )}
        </>
      )}
    </>
  );
}
