import { useEffect, useRef, useState } from 'react';
import { RefreshCw, Send } from 'lucide-react';
import { get, post } from '../../api/client';
import type { AwCash, AwCashClosePreview, AwCashPreview, AwCashResult, AwSalesSummary } from '../../api/types';
import { useAuth } from '../../auth/AuthProvider';
import { fmtMoney } from '../../lib/money';
import { parseSoles } from '../../lib/money';
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

/** Reapertura y cierre de la caja de Apiworking (AperturaCajaChica reabre una caja cerrada): vista previa del JSON, aprobación explícita y un solo envío (sin reintentos). */
function CashCard() {
  const { can } = useAuth();
  const toast = useToast();
  const st = useAsync(() => get<AwCash>('/apiworking/cash'), []);
  const [idCaja, setIdCaja] = useState('');
  const [turn, setTurn] = useState('');
  const [amount, setAmount] = useState('0');
  const [preview, setPreview] = useState<{ data: AwCashPreview; signature: string } | null>(null);
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState<'preview' | 'open' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AwCashResult | null>(null);
  const sending = useRef(false);
  const x = st.data;
  const cents = parseSoles(amount === '0' ? '0.00' : amount);
  const body = x && idCaja && cents !== null && cents >= 0 ? { idCaja, openingCents: cents, idTurno: turn || x.defaultTurn } : null;
  const signature = JSON.stringify(body);
  const current = preview && preview.signature === signature ? preview : null;
  useEffect(() => { if (preview && preview.signature !== signature) setApproved(false); }, [preview, signature]);
  const canOpen = can('apiworking:cash');
  const [closeId, setCloseId] = useState('');
  const [closePrev, setClosePrev] = useState<AwCashClosePreview | null>(null);
  const [closeOk, setCloseOk] = useState(false);
  const reviewClose = async () => {
    setBusy('preview'); setError(null); setCloseOk(false); setResult(null);
    try { setClosePrev(await post<AwCashClosePreview>('/apiworking/cash/close-preview', { idCaja: closeId })); }
    catch (e) { setError(errorText(e)); setClosePrev(null); }
    finally { setBusy(null); }
  };
  const closeCash = async () => {
    if (!closePrev || sending.current) return;
    sending.current = true; setBusy('open'); setError(null);
    try {
      const r = await post<AwCashResult>('/apiworking/cash/close', { idCaja: closeId, approvedHash: closePrev.hash });
      setResult(r); setClosePrev(null); setCloseOk(false); setCloseId('');
      if (r.status === 'CLOSED') toast.success('Caja cerrada');
    } catch (e) { setError(errorText(e)); }
    finally { sending.current = false; setBusy(null); st.reload(); }
  };
  const caja = x?.cajas.find((c) => c.id === idCaja);

  const review = async () => {
    if (!body) return;
    setBusy('preview'); setError(null); setApproved(false); setResult(null);
    try { setPreview({ data: await post<AwCashPreview>('/apiworking/cash/preview', body), signature }); }
    catch (e) { setError(errorText(e)); setPreview(null); }
    finally { setBusy(null); }
  };
  const open = async () => {
    if (!current || !body || sending.current) return;
    sending.current = true; setBusy('open'); setError(null);
    try {
      const r = await post<AwCashResult>('/apiworking/cash/open', { ...body, approvedHash: current.data.hash });
      setResult(r); setPreview(null); setApproved(false);
      if (r.status === 'OPENED') toast.success('Caja reabierta');
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
          <div className="table-wrap table-cards">
            <table>
              <caption className="sr-only">Estado de las cajas autorizadas</caption>
              <thead><tr><th scope="col">Caja</th><th scope="col">Sucursal</th><th scope="col">Estado</th></tr></thead>
              <tbody>{x.cajas.map((c) => <tr key={c.id}><td data-label="Caja">{c.name}</td><td data-label="Sucursal">{c.branch}</td><td data-label="Estado"><Badge tone={c.opened ? 'success' : 'warning'}>{c.opened ? 'Abierta' : 'Cerrada'}</Badge></td></tr>)}</tbody>
            </table>
          </div>
          {canOpen && !x.write && <Alert tone="info">Las escrituras reales están desactivadas en esta instalación: puede preparar la apertura, pero no enviarla.</Alert>}
          {canOpen && (
            <div style={{ marginTop: 'var(--space-4)' }}>
              <SelectField label="Caja a reabrir" value={idCaja} onChange={(e) => setIdCaja(e.target.value)}>
                <option value="">Elija una caja</option>
                {x.cajas.filter((c) => !c.opened).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </SelectField>
              {x.turnos.length > 0 ? (
                <SelectField label="Turno" value={turn || x.defaultTurn} onChange={(e) => setTurn(e.target.value)}>
                  {x.turnos.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </SelectField>
              ) : <TextField label="Turno (id)" value={turn || x.defaultTurn} inputMode="numeric" onChange={(e) => setTurn(e.target.value.replace(/\D/g, ''))} />}
              <TextField label="Monto inicial (S/)" value={amount} inputMode="decimal" onChange={(e) => setAmount(e.target.value)} />
              {error && <Alert tone="danger">{error}</Alert>}
              <div className="chip-row"><Button variant="secondary" disabled={!body} loading={busy === 'preview'} loadingText="Preparando…" onClick={() => void review()}>Revisar reapertura</Button></div>
            </div>
          )}
          {current && (
            <div style={{ marginTop: 'var(--space-4)' }}>
              <p><strong>{caja?.name ?? current.data.caja}</strong> · turno {current.data.turn} · monto inicial <strong>{current.data.openingText}</strong></p>
              {current.data.alreadyOpen && <Alert tone="warning">Esta caja ya figura abierta en Apiworking: no se enviará nada.</Alert>}
              <label className="check" style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-start' }}>
                <input type="checkbox" checked={approved} onChange={(e) => setApproved(e.target.checked)} />
                <span>Revisé los datos y autorizo reabrir esta caja en Apiworking. No se reintenta sola.</span>
              </label>
              <div className="chip-row" style={{ marginTop: 'var(--space-4)' }}>
                <Button variant="primary" icon={<Send size={18} aria-hidden="true" />} disabled={!approved || current.data.alreadyOpen || !x.write} loading={busy === 'open'} loadingText="Reabriendo…" onClick={() => void open()}>Reabrir caja</Button>
              </div>
            </div>
          )}
          {canOpen && x.cajas.some((c) => c.opened) && (
            <div style={{ marginTop: 'var(--space-6)' }}>
              <h3 className="h3">Cerrar caja</h3>
              <SelectField label="Caja a cerrar" value={closeId} onChange={(e) => { setCloseId(e.target.value); setClosePrev(null); setCloseOk(false); }}>
                <option value="">Elija una caja</option>
                {x.cajas.filter((c) => c.opened).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </SelectField>
              <div className="chip-row"><Button variant="secondary" disabled={!closeId} loading={busy === 'preview'} loadingText="Preparando…" onClick={() => void reviewClose()}>Revisar cierre</Button></div>
              {closePrev && (
                <div style={{ marginTop: 'var(--space-4)' }}>
                  <p>Se cerrará <strong>{closePrev.caja}</strong> (turno {closePrev.turn}). El cierre no se puede deshacer desde aquí.</p>
                  <label className="check" style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-start' }}>
                    <input type="checkbox" checked={closeOk} onChange={(e) => setCloseOk(e.target.checked)} />
                    <span>Revisé los datos y autorizo cerrar esta caja en Apiworking. No se reintenta sola.</span>
                  </label>
                  <div className="chip-row" style={{ marginTop: 'var(--space-4)' }}>
                    <Button variant="danger" disabled={!closeOk || !x.write} loading={busy === 'open'} loadingText="Cerrando…" onClick={() => void closeCash()}>Cerrar caja</Button>
                  </div>
                </div>
              )}
            </div>
          )}
          {result && <Alert tone={result.status === 'OPENED' || result.status === 'CLOSED' ? 'success' : 'warning'}>{result.message}{result.note ? ` ${result.note}.` : ''}</Alert>}
        </>
      )}
    </section>
  );
}
