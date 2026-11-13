import { useRef, useState } from 'react';
import { Minus, Plus, RefreshCw } from 'lucide-react';
import { get, post } from '../../api/client';
import type { AwCash, AwCashResult, AwSalesSummary } from '../../api/types';
import { useAuth } from '../../auth/AuthProvider';
import { fmtMoney, parseSoles } from '../../lib/money';
import { useAsync } from '../../lib/useAsync';
import { Button } from '../../ui/Button';
import { SelectField, TextField } from '../../ui/fields';
import { Alert, Badge, ErrorState, errorText, useToast } from '../../ui/feedback';
import { Dialog } from '../../ui/overlays';

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

/**
 * Caja de Apiworking: abrir y cerrar en un clic (el cierre, con el efectivo contado si se indica: cuadre), resumen del movimiento
 * abierto, lo acumulado por forma de pago e ingresos o egresos manuales. Cada envío es único y sin reintentos.
 */
function CashCard() {
  const { can } = useAuth();
  const toast = useToast();
  const st = useAsync(() => get<AwCash>('/apiworking/cash'), []);
  const [turn, setTurn] = useState('');
  const [amount, setAmount] = useState('0');
  const [counted, setCounted] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AwCashResult | null>(null);
  const [moving, setMoving] = useState<{ idCaja: string; type: 'I' | 'E' } | null>(null);
  const sending = useRef(false);
  const x = st.data;
  const cents = parseSoles(amount.trim() === '' || amount === '0' ? '0.00' : amount);
  const canOpen = can('apiworking:cash');

  const run = async (idCaja: string, op: 'open' | 'close') => {
    if (!x || sending.current || (op === 'open' && cents === null)) return;
    const c = counted[idCaja]?.trim();
    const countedCents = c ? parseSoles(c) : null;
    if (op === 'close' && c && countedCents === null) { setError('Revise el efectivo contado.'); return; }
    sending.current = true; setBusy(`${op}:${idCaja}`); setError(null); setResult(null);
    try {
      const r = op === 'open'
        ? await post<AwCashResult>('/apiworking/cash/open', { idCaja, openingCents: cents, idTurno: turn || x.defaultTurn })
        : await post<AwCashResult>('/apiworking/cash/close', { idCaja, ...(countedCents !== null ? { countedCents } : {}) });
      if (r.status === 'OPENED') toast.success('Caja abierta en Apiworking');
      else if (r.status === 'CLOSED') { toast.success(r.message || 'Caja cerrada en Apiworking'); setCounted((all) => ({ ...all, [idCaja]: '' })); }
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
          {canOpen && !x.write && <Alert tone="info">Las escrituras reales están desactivadas en esta instalación: no se puede abrir, cerrar ni registrar movimientos.</Alert>}
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
          {x.cajas.map((c) => (
            <div key={c.id} className="card" style={{ marginTop: 'var(--space-4)' }} aria-label={`Caja ${c.name}`}>
              <div className="card-head">
                <h3 className="h3">{c.name}{c.branch ? <span className="caption muted"> · {c.branch}</span> : null}</h3>
                <Badge tone={c.opened ? 'success' : 'warning'}>{c.opened ? 'Abierta' : 'Cerrada'}</Badge>
              </div>
              {c.opened && c.summary && (
                <>
                  <p className="caption muted">{c.summary.openedAt ? `Abierta el ${c.summary.openedAt}` : 'Abierta'}{c.summary.turn ? ` · ${c.summary.turn}` : ''}</p>
                  <div className="grid-stats" aria-label={`Resumen de la caja ${c.name}`}>
                    <Stat label="Monto inicial" cents={c.summary.openingCents} />
                    <Stat label="Ingresos" cents={c.summary.incomeCents} note={c.summary.voidedIncomeCents ? `Anulados ${fmtMoney(c.summary.voidedIncomeCents)}` : undefined} />
                    <Stat label="Egresos" cents={c.summary.expenseCents} note={c.summary.voidedExpenseCents ? `Anulados ${fmtMoney(c.summary.voidedExpenseCents)}` : undefined} />
                    <Stat label="Saldo" cents={c.summary.balanceCents} strong />
                  </div>
                  {c.methods && c.methods.length > 0 && (
                    <div className="table-wrap table-cards" style={{ marginTop: 'var(--space-3)' }}>
                      <table>
                        <caption className="sr-only">Acumulado por forma de pago en la caja {c.name}</caption>
                        <thead><tr><th scope="col">Forma de pago</th><th scope="col" className="num">Acumulado en la caja</th></tr></thead>
                        <tbody>{c.methods.map((m) => <tr key={m.id}><td data-label="Forma de pago">{m.name}</td><td data-label="Acumulado" className="num">{fmtMoney(m.amountCents)}</td></tr>)}</tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
              {canOpen && (
                <div className="chip-row" style={{ marginTop: 'var(--space-4)', alignItems: 'flex-end' }}>
                  {c.opened ? (
                    <>
                      <Button size="sm" icon={<Plus size={16} aria-hidden="true" />} disabled={!x.write || busy !== null} onClick={() => setMoving({ idCaja: c.id, type: 'I' })}>Registrar ingreso</Button>
                      <Button size="sm" icon={<Minus size={16} aria-hidden="true" />} disabled={!x.write || busy !== null} onClick={() => setMoving({ idCaja: c.id, type: 'E' })}>Registrar egreso</Button>
                      <div style={{ width: '11rem' }}>
                        <TextField label="Efectivo contado (S/)" optional inputMode="decimal" autoComplete="off" value={counted[c.id] ?? ''} onChange={(e) => setCounted((all) => ({ ...all, [c.id]: e.target.value }))} />
                      </div>
                      <Button size="sm" variant="danger" disabled={!x.write || busy !== null} loading={busy === `close:${c.id}`} loadingText="Cerrando…" onClick={() => void run(c.id, 'close')}>Cerrar caja</Button>
                    </>
                  ) : (
                    <Button size="sm" variant="primary" disabled={!x.write || busy !== null || cents === null} loading={busy === `open:${c.id}`} loadingText="Abriendo…" onClick={() => void run(c.id, 'open')}>Abrir caja</Button>
                  )}
                </div>
              )}
              {c.opened && c.summary?.balanceCents != null && counted[c.id]?.trim() && parseSoles(counted[c.id]!) !== null && (
                <p className="caption tabular" role="status">
                  {(() => { const d = parseSoles(counted[c.id]!)! - c.summary!.balanceCents!; return d === 0 ? 'Cuadre perfecto.' : d > 0 ? `Sobrante: ${fmtMoney(d)}.` : `Faltante: ${fmtMoney(-d)}.`; })()}
                </p>
              )}
            </div>
          ))}
          {error && <Alert tone="danger">{error}</Alert>}
          {result && <Alert tone="warning">{result.message}{result.note ? ` ${result.note}.` : ''}</Alert>}
        </>
      )}
      {moving && x && (
        <MovementDialog
          type={moving.type} idCaja={moving.idCaja} types={(x.operationTypes ?? []).filter((t) => t.flow === moving.type)}
          onClose={() => setMoving(null)}
          onDone={(r) => { setMoving(null); st.reload(); if (r.status === 'REGISTERED') toast.success(r.message); else setResult(r); }}
        />
      )}
    </section>
  );
}

function Stat({ label, cents, note, strong }: { label: string; cents: number | null; note?: string; strong?: boolean }) {
  return (
    <div className="card stat">
      <span className="muted">{label}</span>
      <span className="stat-value tabular" style={strong ? undefined : { fontSize: '1.25rem' }}>{cents === null ? '—' : fmtMoney(cents)}</span>
      {note && <span className="caption muted">{note}</span>}
    </div>
  );
}

/** Ingreso o egreso manual: tipo de operación del tenant, monto, descripción y, si hay, el comprobante del gasto. */
function MovementDialog({ type, idCaja, types, onClose, onDone }: { type: 'I' | 'E'; idCaja: string; types: { code: string; name: string }[]; onClose: () => void; onDone: (r: AwCashResult) => void }) {
  const [operationType, setOperationType] = useState(types[0]?.code ?? '');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [docType, setDocType] = useState('');
  const [serie, setSerie] = useState('');
  const [number, setNumber] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sending = useRef(false);
  const cents = parseSoles(amount);
  const withDoc = Boolean(docType || serie || number);
  const invalid = !operationType || cents === null || cents < 1 || description.trim().length < 3 || (withDoc && !(docType && serie && number));
  const submit = async () => {
    if (invalid || sending.current) return;
    sending.current = true; setBusy(true); setError(null);
    try {
      onDone(await post<AwCashResult>('/apiworking/cash/movements', { idCaja, type, operationType, amountCents: cents, description: description.trim(), ...(withDoc ? { docType, serie: serie.trim(), number: number.trim() } : {}) }));
    } catch (e) { setError(errorText(e)); setBusy(false); sending.current = false; }
  };
  const title = type === 'I' ? 'Registrar ingreso' : 'Registrar egreso';
  return (
    <Dialog title={title} onClose={onClose} footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" disabled={invalid} loading={busy} loadingText="Registrando…" onClick={() => void submit()}>{title}</Button></>}>
      {error && <Alert tone="danger">{error}</Alert>}
      {types.length === 0 && <Alert tone="warning">No hay tipos de operación configurados para {type === 'I' ? 'ingresos' : 'egresos'}.</Alert>}
      <SelectField label="Tipo de operación" value={operationType} onChange={(e) => setOperationType(e.target.value)}>
        {types.map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}
      </SelectField>
      <TextField label="Monto (S/)" inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} />
      <TextField label="Descripción" help={type === 'I' ? 'Por ejemplo «Reposición de sencillo».' : 'Por ejemplo «Taxi al laboratorio» o «Compra de guantes».'} value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} />
      <fieldset style={{ border: 0, padding: 0 }}>
        <legend className="caption muted">Comprobante (opcional)</legend>
        <div className="row-2">
          <SelectField label="Tipo" optional value={docType} onChange={(e) => setDocType(e.target.value)}>
            <option value="">Sin comprobante</option><option value="7">Nota de venta</option><option value="2">Boleta</option><option value="1">Factura</option>
          </SelectField>
          <TextField label="Serie" optional value={serie} maxLength={6} onChange={(e) => setSerie(e.target.value.toUpperCase())} />
          <TextField label="Número" optional inputMode="numeric" value={number} maxLength={10} onChange={(e) => setNumber(e.target.value.replace(/\D/g, ''))} />
        </div>
      </fieldset>
      <p className="caption muted">Se envía una sola vez a Apiworking y no se puede anular desde aquí.</p>
    </Dialog>
  );
}
