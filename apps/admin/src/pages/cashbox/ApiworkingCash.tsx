import { useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { get, post } from '../../api/client';
import type { AwCash, AwCashResult, AwSalesSummary } from '../../api/types';
import { useAuth } from '../../auth/AuthProvider';
import { fmtMoney, parseSoles } from '../../lib/money';
import { useAsync } from '../../lib/useAsync';
import { Button } from '../../ui/Button';
import { SelectField, TextField } from '../../ui/fields';
import { Alert, Badge, ErrorState, errorText, useToast } from '../../ui/feedback';

/** Caja de Apiworking dentro de la caja chica: ventas del día por forma de pago, y apertura y cierre de la caja. */
export function ApiworkingCash() {
  return (
    <>
      <SalesSummary />
      <CashCard />
    </>
  );
}

function SalesSummary() {
  const sum = useAsync(() => get<AwSalesSummary>('/apiworking/sales/summary'), []);
  const x = sum.data;
  return (
    <section className="card" aria-labelledby="sum-h" style={{ marginBottom: 'var(--space-6)' }}>
      <div className="card-head"><h2 id="sum-h" className="h3">Ventas de hoy por forma de pago</h2><Button size="sm" icon={<RefreshCw size={16} aria-hidden="true" />} onClick={sum.reload}>Actualizar</Button></div>
      {sum.error != null && <ErrorState error={sum.error} onRetry={sum.reload} />}
      {x && x.count === 0 && <p className="muted">Todavía no hay ventas registradas hoy.</p>}
      {x && x.count > 0 && (
        <div className="table-wrap table-cards">
          <table>
            <caption className="sr-only">Ventas del día por forma de pago</caption>
            <thead><tr><th scope="col">Forma de pago</th><th scope="col" className="num">Ventas</th><th scope="col" className="num">Importe</th></tr></thead>
            <tbody>
              {x.methods.map((m) => <tr key={m.methodId}><td data-label="Forma de pago">{m.name}</td><td data-label="Ventas" className="num">{m.count}</td><td data-label="Importe" className="num amount-in">{m.totalText}</td></tr>)}
              <tr><td data-label="Forma de pago"><strong>Total</strong></td><td data-label="Ventas" className="num"><strong>{x.count}</strong></td><td data-label="Importe" className="num"><strong>{fmtMoney(x.totalCents)}</strong></td></tr>
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Apertura y cierre de la caja de Apiworking en un clic (un solo envío, sin reintentos). AperturaCajaChica también reabre una caja cerrada. */
function CashCard() {
  const { can } = useAuth();
  const toast = useToast();
  const st = useAsync(() => get<AwCash>('/apiworking/cash'), []);
  const [turn, setTurn] = useState('');
  const [amount, setAmount] = useState('0');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AwCashResult | null>(null);
  const sending = useRef(false);
  const x = st.data;
  const cents = parseSoles(amount.trim() === '' || amount === '0' ? '0.00' : amount);
  const canOpen = can('apiworking:cash');

  const run = async (idCaja: string, op: 'open' | 'close') => {
    if (!x || sending.current || (op === 'open' && cents === null)) return;
    sending.current = true; setBusy(`${op}:${idCaja}`); setError(null); setResult(null);
    try {
      const r = op === 'open'
        ? await post<AwCashResult>('/apiworking/cash/open', { idCaja, openingCents: cents, idTurno: turn || x.defaultTurn })
        : await post<AwCashResult>('/apiworking/cash/close', { idCaja });
      if (r.status === 'OPENED') toast.success('Caja abierta en Apiworking');
      else if (r.status === 'CLOSED') toast.success('Caja cerrada en Apiworking');
      else setResult(r);
    } catch (e) { setError(errorText(e)); }
    finally { sending.current = false; setBusy(null); st.reload(); }
  };

  return (
    <section className="card" aria-labelledby="cash-h" style={{ marginTop: 'var(--space-8)' }}>
      <div className="card-head"><h2 id="cash-h" className="h3">Caja de Apiworking</h2><Button size="sm" icon={<RefreshCw size={16} aria-hidden="true" />} onClick={st.reload}>Actualizar</Button></div>
      {st.error != null && <ErrorState error={st.error} onRetry={st.reload} />}
      {x && x.cajas.length === 0 && <p className="muted">Su usuario de Apiworking no tiene cajas asignadas.</p>}
      {x && x.cajas.length > 0 && (
        <>
          {canOpen && !x.write && <Alert tone="info">Las escrituras reales están desactivadas en esta instalación: no se puede abrir ni cerrar la caja.</Alert>}
          {canOpen && x.cajas.some((c) => !c.opened) && (
            <div className="row-2">
              {x.turnos.length > 1 && (
                <SelectField label="Turno" value={turn || x.defaultTurn} onChange={(e) => setTurn(e.target.value)}>
                  {x.turnos.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </SelectField>
              )}
              <TextField label="Monto inicial (S/)" help="Para abrir la caja." value={amount} inputMode="decimal" onChange={(e) => setAmount(e.target.value)} />
            </div>
          )}
          <div className="table-wrap table-cards">
            <table>
              <caption className="sr-only">Estado de las cajas</caption>
              <thead><tr><th scope="col">Caja</th><th scope="col">Sucursal</th><th scope="col">Estado</th>{canOpen && <th scope="col">Acción</th>}</tr></thead>
              <tbody>
                {x.cajas.map((c) => (
                  <tr key={c.id}>
                    <td data-label="Caja">{c.name}</td>
                    <td data-label="Sucursal">{c.branch}</td>
                    <td data-label="Estado"><Badge tone={c.opened ? 'success' : 'warning'}>{c.opened ? 'Abierta' : 'Cerrada'}</Badge></td>
                    {canOpen && (
                      <td data-label="Acción">
                        {c.opened
                          ? <Button size="sm" variant="danger" disabled={!x.write || busy !== null} loading={busy === `close:${c.id}`} loadingText="Cerrando…" onClick={() => void run(c.id, 'close')}>Cerrar caja</Button>
                          : <Button size="sm" variant="primary" disabled={!x.write || busy !== null || cents === null} loading={busy === `open:${c.id}`} loadingText="Abriendo…" onClick={() => void run(c.id, 'open')}>Abrir caja</Button>}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {error && <Alert tone="danger">{error}</Alert>}
          {result && <Alert tone="warning">{result.message}{result.note ? ` ${result.note}.` : ''}</Alert>}
        </>
      )}
    </section>
  );
}
