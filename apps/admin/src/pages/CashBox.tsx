import { useRef, useState } from 'react';
import { ArrowDownCircle, ArrowUpCircle, Ban, FileDown, ListOrdered, LockKeyhole, Settings, Unlock } from 'lucide-react';
import { get, post } from '../api/client';
import type { CashConfig, CashMovement, CashMovementList, CashSummary } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { fmtDateTime } from '../lib/format';
import { fmtMoney } from '../lib/money';
import { useAsync } from '../lib/useAsync';
import { Button } from '../ui/Button';
import { ActionMenu } from '../ui/ActionMenu';
import { SelectField, TextField } from '../ui/fields';
import { Alert, Badge, EmptyState, ErrorState, Loading, useToast } from '../ui/feedback';
import { ReasonDialog } from '../ui/overlays';
import { ConfigDrawer } from './cashbox/ConfigDrawer';
import { MovementDialog } from './cashbox/MovementDialog';
import { ReportDialog } from './cashbox/ReportDialog';
import { ApiworkingCash } from './cashbox/ApiworkingCash';
import { CloseCashDialog, OpenCashDialog } from './cashbox/SessionDialogs';

const PAGE = 50;
type Modal = null | 'income' | 'expense' | 'open' | 'close' | 'report' | 'config';

/** Caja chica de la sede: saldos, movimientos, apertura y cierre con conciliación, y reporte en PDF. */
export function CashBoxPage() {
  const { me, can, authMode } = useAuth();
  const awCash = authMode === 'apiworking' && can('apiworking:read');
  const toast = useToast();
  const hasBranch = Boolean(me?.context?.branch);
  const summary = useAsync(() => (hasBranch ? get<CashSummary>('/cashbox/summary') : Promise.resolve(null)), [hasBranch]);
  const config = useAsync(() => (hasBranch ? get<CashConfig>('/cashbox/config') : Promise.resolve(null)), [hasBranch]);
  const [filters, setFilters] = useState({ from: '', to: '', flow: '', accountId: '', userId: '', includeVoided: false });
  const [limit, setLimit] = useState(PAGE);
  const movements = useAsync(
    () => (hasBranch ? get<CashMovementList>('/cashbox/movements', { ...filters, includeVoided: filters.includeVoided || undefined, limit }) : Promise.resolve(null)),
    [hasBranch, filters.from, filters.to, filters.flow, filters.accountId, filters.userId, filters.includeVoided, limit],
  );
  const [modal, setModal] = useState<Modal>(null);
  const [voiding, setVoiding] = useState<CashMovement | null>(null);
  const tableRef = useRef<HTMLElement>(null);
  const set = (patch: Partial<typeof filters>) => { setFilters((f) => ({ ...f, ...patch })); setLimit(PAGE); };
  const reloadAll = () => { summary.reload(); movements.reload(); config.reload(); };

  if (!hasBranch) {
    return (
      <>
        <div className="page-head"><h1>Caja chica</h1></div>
        <Alert tone="info" title="Elija una sede">La caja chica es de cada sede. Use «Cambiar sede» para trabajar en una sede concreta.</Alert>
        {awCash && <ApiworkingCash />}
      </>
    );
  }
  const s = summary.data;
  const cfg = config.data;
  const isOpen = Boolean(s?.session);
  const write = can('cashbox:write');
  const balances = Object.fromEntries((s?.accounts ?? []).map((a) => [a.id, a.balanceCents]));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Caja chica</h1>
          <p className="muted">{s?.branch.name}{s?.session ? ` · Abierta por ${s.session.openedBy} el ${fmtDateTime(s.session.openedAt)}` : ' · Cerrada'}</p>
        </div>
        <ActionMenu
          label="Acciones"
          items={[
            { key: 'in', label: 'Nuevo ingreso', icon: <ArrowDownCircle size={18} aria-hidden="true" />, onSelect: () => setModal('income'), disabled: !isOpen, hint: isOpen ? undefined : 'Abra la caja para registrar movimientos' },
            { key: 'out', label: 'Nuevo egreso', icon: <ArrowUpCircle size={18} aria-hidden="true" />, onSelect: () => setModal('expense'), disabled: !isOpen, hint: isOpen ? undefined : 'Abra la caja para registrar movimientos' },
            { key: 'view', label: 'Visualizar movimientos', icon: <ListOrdered size={18} aria-hidden="true" />, onSelect: () => { tableRef.current?.scrollIntoView?.({ block: 'start' }); tableRef.current?.focus(); } },
            { key: 'pdf', label: 'Exportar PDF', icon: <FileDown size={18} aria-hidden="true" />, onSelect: () => setModal('report') },
            { key: 'sess', label: isOpen ? 'Cerrar caja' : 'Abrir caja', icon: isOpen ? <LockKeyhole size={18} aria-hidden="true" /> : <Unlock size={18} aria-hidden="true" />, onSelect: () => setModal(isOpen ? 'close' : 'open'), separatorBefore: true },
            { key: 'cfg', label: 'Configurar cuentas y tipos', icon: <Settings size={18} aria-hidden="true" />, onSelect: () => setModal('config') },
          ].filter((i) => (i.key === 'in' || i.key === 'out' ? write : i.key === 'sess' ? can('cashbox:close') : i.key === 'cfg' ? can('cashbox:manage') : true))}
        />
      </div>

      {summary.loading && !s && <Loading rows={2} />}
      {summary.error != null && <ErrorState error={summary.error} onRetry={summary.reload} />}
      {s && !isOpen && (
        <Alert tone="warning" title="La caja está cerrada" action={can('cashbox:close') ? <Button variant="primary" onClick={() => setModal('open')}>Abrir caja</Button> : undefined}>
          {s.lastClosedAt ? `Se cerró el ${fmtDateTime(s.lastClosedAt)}. ` : ''}Para registrar ingresos y egresos hay que abrirla con el saldo inicial.
        </Alert>
      )}
      {awCash && <ApiworkingCash />}
      {s && (
        <>
          <div className="grid-stats" aria-label="Resumen de la caja">
            <div className="card stat"><span className="muted">Saldo inicial</span><span className="stat-value">{fmtMoney(s.totals.openingCents)}</span><span className="caption muted">{isOpen ? 'al abrir la caja' : 'sin caja abierta'}</span></div>
            <div className="card stat"><span className="muted">Total de ingresos</span><span className="stat-value stat-income">{fmtMoney(s.totals.incomeCents)}</span></div>
            <div className="card stat"><span className="muted">Total de egresos</span><span className="stat-value stat-expense">{fmtMoney(s.totals.expenseCents)}</span></div>
            <div className="card stat"><span className="muted">Saldo disponible</span><span className="stat-value">{fmtMoney(s.totals.balanceCents)}</span><span className="caption muted">todas las cuentas</span></div>
          </div>
          {s.accounts.length > 0 && (
            <section className="card" aria-labelledby="acc-h" style={{ marginBottom: 'var(--space-6)' }}>
              <h2 id="acc-h" className="h3" style={{ marginBottom: 'var(--space-4)' }}>Saldos por cuenta</h2>
              <div className="table-wrap table-cards">
                <table>
                  <caption className="sr-only">Saldos por cuenta o medio de pago</caption>
                  <thead><tr><th scope="col">Cuenta</th><th scope="col" className="num">Saldo inicial</th><th scope="col" className="num">Ingresos</th><th scope="col" className="num">Egresos</th><th scope="col" className="num">Saldo disponible</th></tr></thead>
                  <tbody>
                    {s.accounts.map((a) => (
                      <tr key={a.id}>
                        <td data-label="Cuenta">{a.name}{!a.active && <> <Badge tone="warning">Inactiva</Badge></>}</td>
                        <td data-label="Saldo inicial" className="num">{a.openingCents === null ? '—' : fmtMoney(a.openingCents)}</td>
                        <td data-label="Ingresos" className="num amount-in">{fmtMoney(a.incomeCents)}</td>
                        <td data-label="Egresos" className="num amount-out">{fmtMoney(a.expenseCents)}</td>
                        <td data-label="Saldo disponible" className="num"><strong>{fmtMoney(a.balanceCents)}</strong></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}

      <section ref={tableRef} tabIndex={-1} className="card" aria-labelledby="mov-h" style={{ outline: 'none' }}>
        <h2 id="mov-h" className="h3" style={{ marginBottom: 'var(--space-4)' }}>Movimientos</h2>
        <form className="toolbar" aria-label="Filtros de movimientos" onSubmit={(e) => e.preventDefault()}>
          <TextField label="Desde" type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => set({ from: e.target.value })} />
          <TextField label="Hasta" type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => set({ to: e.target.value })} />
          <SelectField label="Tipo de operación" value={filters.flow} onChange={(e) => set({ flow: e.target.value })}>
            <option value="">Todas</option><option value="INCOME">Ingresos</option><option value="EXPENSE">Egresos</option>
          </SelectField>
          <SelectField label="Medio de pago" value={filters.accountId} onChange={(e) => set({ accountId: e.target.value })}>
            <option value="">Todos</option>{cfg?.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </SelectField>
          <SelectField label="Usuario" value={filters.userId} onChange={(e) => set({ userId: e.target.value })}>
            <option value="">Todos</option>{cfg?.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </SelectField>
          <label className="check" style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', minHeight: 44 }}>
            <input type="checkbox" checked={filters.includeVoided} onChange={(e) => set({ includeVoided: e.target.checked })} /> Mostrar anulados
          </label>
        </form>
        <div aria-live="polite">
          {movements.loading && !movements.data && <Loading rows={3} />}
          {movements.error != null && <ErrorState error={movements.error} onRetry={movements.reload} />}
          {movements.data?.items.length === 0 && <EmptyState title="Sin movimientos">{isOpen ? 'Registre el primero desde «Acciones».' : 'No hay movimientos con estos filtros.'}</EmptyState>}
          {movements.data && movements.data.items.length > 0 && (
            <>
              <div className="table-wrap table-cards">
                <table>
                  <caption className="sr-only">Historial de movimientos de caja chica</caption>
                  <thead><tr><th scope="col">Fecha</th><th scope="col">Tipo</th><th scope="col">Descripción</th><th scope="col">Medio de pago</th><th scope="col">Usuario</th><th scope="col" className="num">Monto</th><th scope="col">Estado</th></tr></thead>
                  <tbody>
                    {movements.data.items.map((m) => (
                      <tr key={m.id} className={m.status === 'VOIDED' ? 'row-voided' : undefined}>
                        <td data-label="Fecha" className="tabular">{fmtDateTime(m.occurredAt)}</td>
                        <td data-label="Tipo"><Badge tone={m.kind !== 'NORMAL' ? 'neutral' : m.flow === 'INCOME' ? 'success' : 'danger'}>{m.kind !== 'NORMAL' ? 'Ajuste' : m.flowLabel}</Badge></td>
                        <td data-label="Descripción">{m.description}<br /><span className="caption muted">{[m.category?.name, m.kind !== 'NORMAL' ? m.kindLabel : null, m.operationNumber ? `Op. ${m.operationNumber}` : null].filter(Boolean).join(' · ')}</span></td>
                        <td data-label="Medio de pago">{m.account.name}</td>
                        <td data-label="Usuario">{m.user.name}</td>
                        <td data-label="Monto" className={`num ${m.flow === 'INCOME' ? 'amount-in' : 'amount-out'}`}>{m.flow === 'INCOME' ? '+' : '−'} {m.amountText}</td>
                        <td data-label="Estado">
                          {m.status === 'VOIDED' ? <Badge tone="neutral">Anulado</Badge> : can('cashbox:void') && isOpen && m.kind === 'NORMAL'
                            ? <Button size="sm" variant="tertiary" icon={<Ban size={16} aria-hidden="true" />} aria-label={`Anular ${m.flowLabel.toLowerCase()} ${m.description}`} onClick={() => setVoiding(m)}>Anular</Button> : <Badge tone="success">Vigente</Badge>}
                          {m.status === 'VOIDED' && m.voidReason && <><br /><span className="caption muted">{m.voidReason}</span></>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="caption muted" style={{ marginTop: 'var(--space-4)' }}>
                Mostrando {movements.data.items.length} de {movements.data.total}. Con los filtros: ingresos <strong>{fmtMoney(movements.data.incomeCents)}</strong> · egresos <strong>{fmtMoney(movements.data.expenseCents)}</strong>.
              </p>
              {movements.data.items.length < movements.data.total && <Button onClick={() => setLimit((l) => l + PAGE)}>Ver más movimientos</Button>}
            </>
          )}
        </div>
      </section>

      {(modal === 'income' || modal === 'expense') && cfg && (
        <MovementDialog flow={modal === 'income' ? 'INCOME' : 'EXPENSE'} config={cfg} balances={balances} onClose={() => setModal(null)}
          onSaved={() => { setModal(null); toast.success(modal === 'income' ? 'Ingreso registrado.' : 'Egreso registrado.'); reloadAll(); }} />
      )}
      {modal === 'open' && s && <OpenCashDialog summary={s} onClose={() => setModal(null)} onDone={() => { setModal(null); toast.success('Caja abierta.'); reloadAll(); }} />}
      {modal === 'close' && s && (
        <CloseCashDialog summary={s} onClose={() => setModal(null)} onDone={(diff) => { setModal(null); toast.success(diff === 0 ? 'Caja cerrada: efectivo conciliado.' : `Caja cerrada con una diferencia de ${fmtMoney(diff)}.`); reloadAll(); }} />
      )}
      {modal === 'report' && <ReportDialog onClose={() => setModal(null)} />}
      {modal === 'config' && cfg && <ConfigDrawer config={cfg} onClose={() => setModal(null)} onChanged={reloadAll} />}
      {voiding && (
        <ReasonDialog title="Anular movimiento" danger confirmLabel="Anular movimiento" example="Se registró con el monto equivocado"
          explain={`Se anulará el ${voiding.flowLabel.toLowerCase()} «${voiding.description}» de ${voiding.amountText}. Dejará de sumar en los saldos y queda en el historial.`}
          onClose={() => setVoiding(null)}
          onConfirm={async (reason) => { await post(`/cashbox/movements/${voiding.id}/void`, { reason }); setVoiding(null); toast.success('Movimiento anulado.'); reloadAll(); }} />
      )}
    </>
  );
}
