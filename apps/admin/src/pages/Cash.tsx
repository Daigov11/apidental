import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Wallet } from 'lucide-react';
import { get } from '../api/client';
import type { Charge } from '../api/types';
import { fmtDateTime } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import { SelectField } from '../ui/fields';
import { Badge, DocStatusBadge, EmptyState, ErrorState, Loading, SimulatedTag } from '../ui/feedback';

const TONE = { PENDING: 'warning', PAID: 'success', VOIDED: 'neutral' } as const;

export function CashPage() {
  const [status, setStatus] = useState('');
  const list = useAsync(() => get<Charge[]>('/billing/charges', { status: status || undefined, limit: 50 }), [status]);
  return (
    <>
      <div className="page-head"><h1>Caja</h1><SimulatedTag /></div>
      <p className="muted" style={{ marginBottom: 'var(--space-5)' }}>Cobros de atenciones. Para cobrar, abra una cita atendida en la agenda y elija «Registrar cobro».</p>
      <div className="toolbar">
        <SelectField label="Estado" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Todos</option><option value="PENDING">Pendiente de pago</option><option value="PAID">Pagado</option><option value="VOIDED">Anulado</option>
        </SelectField>
      </div>
      {list.loading && !list.data && <Loading rows={4} />}
      {list.error != null && <ErrorState error={list.error} onRetry={list.reload} />}
      {list.data?.length === 0 && <EmptyState icon={<Wallet size={32} aria-hidden="true" />} title="No hay cobros todavía">Atienda una cita y registre su cobro desde la agenda.</EmptyState>}
      {list.data && list.data.length > 0 && (
        <div className="table-wrap table-cards">
          <table>
            <caption className="sr-only">Cobros</caption>
            <thead><tr><th scope="col">Fecha</th><th scope="col">Paciente</th><th scope="col">Concepto</th><th scope="col" className="num">Monto</th><th scope="col">Estado</th><th scope="col">Comprobante</th></tr></thead>
            <tbody>
              {list.data.map((c) => (
                <tr key={c.id}>
                  <td data-label="Fecha" className="tabular">{fmtDateTime(c.createdAt)}</td>
                  <td data-label="Paciente"><Link className="row-link" to={`/caja/${c.id}`}>{c.patient.name}</Link></td>
                  <td data-label="Concepto">{c.description}</td>
                  <td data-label="Monto" className="num">{c.amountText}</td>
                  <td data-label="Estado"><Badge tone={TONE[c.status]}>{c.statusLabel}</Badge></td>
                  <td data-label="Comprobante">{c.document ? <><DocStatusBadge status={c.document.status} label={c.document.statusLabel} /> <span className="caption muted tabular">{c.document.number}</span></> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
