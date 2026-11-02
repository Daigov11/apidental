import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Plus, RefreshCw, Search, Send, Trash2 } from 'lucide-react';
import { get, post } from '../api/client';
import type { AwBillingDraft, AwCash, AwCustomerPreview, AwCustomerResult, AwCashClosePreview, AwCashPreview, AwCashResult, AwContext, AwCustomer, AwDiscovery, AwDraft, AwLine, AwPreview, AwSale, AwStatus, AwVerify, CashConfig, CashSummary } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { fmtDateTime } from '../lib/format';
import { fmtMoney, parseSoles } from '../lib/money';
import { useAsync } from '../lib/useAsync';
import { Button } from '../ui/Button';
import { SelectField, TextField } from '../ui/fields';
import { Alert, Badge, EmptyState, ErrorState, Loading, errorText, useToast } from '../ui/feedback';
import { Dialog, ReasonDialog } from '../ui/overlays';

interface LineField { name: string; quantity: string; price: string }
const emptyLine = (): LineField => ({ name: '', quantity: '1', price: '' });
const DOC_TONE = { PENDING_ISSUE: 'warning', PENDING: 'info', SENT: 'success', REJECTED: 'danger', PENDING_RECONCILIATION: 'warning' } as const;
const PAY_TONE = { NO_EVIDENCE: 'neutral', CONFIRMED_REMOTE: 'success', CONFIRMED_RECONCILED: 'success' } as const;
const SUGGESTED = { FACTURA: 'Factura', BOLETA: 'Boleta', NOTA_DE_VENTA: 'Nota de venta' } as const;

/** Ventas registradas en Apiworking (registro-documento): se prepara, se revisa el JSON exacto y solo entonces se envía. */
export function VentasPage() {
  const { can } = useAuth();
  const toast = useToast();
  const status = useAsync(() => get<AwStatus>('/apiworking/status'), []);
  const sales = useAsync(() => get<{ items: AwSale[]; total: number }>('/apiworking/sales', { limit: 30 }), []);
  const session = status.data?.session ?? false;
  const canSell = can('apiworking:sell');
  const [params, setParams] = useSearchParams();
  const urlAppointmentId = params.get('appointmentId') ?? undefined;
  const urlPatientId = params.get('patientId') ?? undefined;
  // Contingencia: Apiworking no responde; el cobro entra en la caja local y el documento queda por emitir.
  const [contingency, setContingency] = useState(false);
  // Venta cobrada en contingencia que se está emitiendo ahora (completa ESA fila).
  const [pendingSale, setPendingSale] = useState<AwSale | null>(null);
  const [docDate, setDocDate] = useState('');
  const link = pendingSale
    ? { appointmentId: pendingSale.appointmentId ?? undefined, patientId: pendingSale.patientId ?? undefined }
    : { appointmentId: urlAppointmentId, patientId: urlPatientId };
  const billing = useAsync(() => (urlAppointmentId || urlPatientId ? get<AwBillingDraft>('/apiworking/billing-draft', { appointmentId: urlAppointmentId, patientId: urlPatientId }) : Promise.resolve(null)), [urlAppointmentId, urlPatientId]);

  // --- Cliente ---
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => { const t = setTimeout(() => setDebounced(query.trim()), 300); return () => clearTimeout(t); }, [query]);
  const [customer, setCustomer] = useState<AwCustomer | null>(null);
  const found = useAsync(
    () => ((session || contingency) && !customer ? get<{ items: AwCustomer[]; total: number; offline?: boolean }>('/apiworking/clients', { search: debounced, limit: 8, ...(contingency ? { local: 1 } : {}) }) : Promise.resolve({ items: [], total: 0 })),
    [debounced, session, customer, contingency],
  );

  // --- Caja, documento, serie y forma de pago (siempre dentro de lo autorizado) ---
  const [idCaja, setIdCaja] = useState('');
  const [idTipoDocumento, setIdTipoDocumento] = useState('');
  const [idSerie, setIdSerie] = useState('');
  const [idMetodoPago, setIdMetodoPago] = useState('');
  const ctx = useAsync(() => (session && !contingency ? get<AwContext>('/apiworking/sales/context', { idCaja, idTipoDocumento }) : Promise.resolve(null)), [session, contingency, idCaja, idTipoDocumento]);
  const c = ctx.data;

  // --- Detalle ---
  const [description, setDescription] = useState('');
  const [lines, setLines] = useState<LineField[]>([emptyLine()]);
  const parsed = useMemo(() => lines.map((l) => ({ name: l.name.trim(), quantity: Number(l.quantity), cents: parseSoles(l.price) })), [lines]);
  const validLines = parsed.every((l) => l.name.length >= 2 && Number.isInteger(l.quantity) && l.quantity >= 1 && l.quantity <= 999 && l.cents !== null && l.cents > 0);
  const total = parsed.reduce((s, l) => s + (l.cents ?? 0) * (Number.isFinite(l.quantity) ? l.quantity : 0), 0);

  const draft: AwDraft | null = customer && idCaja && idTipoDocumento && idSerie && idMetodoPago && description.trim().length >= 3 && validLines
    ? {
      customerId: customer.id, idCaja, idTipoDocumento, idSerie, idMetodoPago, description: description.trim(), lines: parsed.map((l): AwLine => ({ name: l.name, quantity: l.quantity, unitPriceCents: l.cents! })),
      ...(link.appointmentId ? { appointmentId: link.appointmentId } : {}), ...(link.patientId ? { patientId: link.patientId } : {}),
      ...(pendingSale ? { pendingSaleId: pendingSale.id } : {}), ...(docDate ? { docDate } : {}),
    }
    : null;
  const signature = JSON.stringify(draft);

  // Cobro desde una cita atendida o un paciente: cliente por su documento, servicio y precio de referencia.
  const prefilled = useRef<string | null>(null);
  useEffect(() => {
    const b = billing.data;
    if (!b || prefilled.current === (b.appointment?.id ?? b.patient.id)) return;
    prefilled.current = b.appointment?.id ?? b.patient.id;
    if (b.customer) setCustomer(b.customer);
    if (b.description) setDescription(b.description);
    if (b.description && b.amountCents) setLines([{ name: b.description, quantity: '1', price: (b.amountCents / 100).toFixed(2) }]);
  }, [billing.data]);

  // --- Vista previa y envío ---
  const [preview, setPreview] = useState<{ data: AwPreview; signature: string; key: string } | null>(null);
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState<'preview' | 'send' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Si algo cambia después de la vista previa, la aprobación deja de valer.
  const current = preview && preview.signature === signature ? preview : null;
  useEffect(() => { if (preview && preview.signature !== signature) setApproved(false); }, [preview, signature]);

  const review = async () => {
    if (!draft) return;
    setBusy('preview'); setError(null); setApproved(false);
    try {
      const data = await post<AwPreview>('/apiworking/sales/preview', draft);
      setPreview({ data, signature, key: crypto.randomUUID() });
    } catch (e) { setError(errorText(e)); setPreview(null); }
    finally { setBusy(null); }
  };

  const reset = () => { setPendingSale(null); setDocDate(''); setCustomer(null); setQuery(''); setDescription(''); setLines([emptyLine()]); setPreview(null); setApproved(false); setIdSerie(''); setIdMetodoPago(''); };
  // Una sola clave por envío: un doble clic o un reintento no registra dos veces la misma venta.
  const sending = useRef(false);
  const send = async () => {
    if (!draft || !current || !approved || sending.current) return;
    sending.current = true;
    setBusy('send'); setError(null);
    try {
      const sale = await post<AwSale>('/apiworking/sales', { ...draft, approvedHash: current.data.hash, idempotencyKey: current.key });
      if (sale.docStatus === 'SENT') toast.success(`Venta registrada en Apiworking${sale.externalNumber ? ` (${sale.externalNumber})` : ''}. El cobro queda sin confirmar hasta verificarlo.`);
      else if (sale.docStatus === 'PENDING_RECONCILIATION') toast.error('No se sabe si Apiworking registró la venta. Verifíquela y concilie antes de volver a enviarla.');
      else toast.error(`Apiworking rechazó la venta: ${sale.failureReason ?? 'sin detalle'}`);
      reset();
      if (urlAppointmentId || urlPatientId) setParams({}, { replace: true });
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(null); sending.current = false; sales.reload(); status.reload(); }
  };

  // --- Acciones sobre ventas ---
  const [verifyResult, setVerifyResult] = useState<AwVerify | null>(null);
  const [reconcileOf, setReconcileOf] = useState<AwSale | null>(null);
  const [voidOf, setVoidOf] = useState<AwSale | null>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const verify = async (s: AwSale) => {
    setRowBusy(s.id);
    try { setVerifyResult(await post<AwVerify>(`/apiworking/sales/${s.id}/verify`)); sales.reload(); }
    catch (e) { toast.error(errorText(e)); }
    finally { setRowBusy(null); }
  };

  const startIssue = (s: AwSale) => {
    setContingency(false); setPendingSale(s); setPreview(null); setApproved(false); setIdCaja(''); setIdTipoDocumento(''); setIdSerie(''); setIdMetodoPago('');
    setCustomer({ id: s.customerId, personId: '', name: s.customer.name, email: '', docType: s.customer.docType, docNumber: s.customer.docNumber, phone: '', whatsapp: '', personType: '', active: true });
    setDescription(s.description);
    setLines(s.lines.map((l) => ({ name: l.name, quantity: String(l.quantity), price: (l.unitPriceCents / 100).toFixed(2) })));
    setDocDate(s.docDate);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  if (status.loading && !status.data) return <Loading label="Consultando Apiworking" rows={3} />;
  if (status.error != null) return <ErrorState error={status.error} onRetry={status.reload} />;
  const st = status.data!;
  const readOnly = !st.write;

  return (
    <>
      <div className="page-head">
        <div><h1>Ventas Apiworking</h1><p className="muted">Tenant: <span className="tabular">{st.tenant ?? '—'}</span></p></div>
        {canSell && can('cashbox:write') && st.read && (
          <Button size="sm" variant={contingency ? 'primary' : 'tertiary'} onClick={() => { setContingency((v) => !v); setPendingSale(null); setPreview(null); setApproved(false); }}>
            {contingency ? 'Salir de contingencia' : 'Apiworking no responde: cobrar en contingencia'}
          </Button>
        )}
      </div>
      {!st.configured && <Alert tone="warning" title="Apiworking no está configurado">Esta instalación no tiene el tenant de Apiworking configurado.</Alert>}
      {st.configured && !st.read && <Alert tone="warning" title="Lecturas desactivadas">Las consultas reales a Apiworking están apagadas en esta instalación.</Alert>}
      {st.configured && st.read && !session && <Alert tone="warning" title="Vuelva a ingresar">Su sesión de Apiworking ya no está disponible (por ejemplo, tras reiniciar el servidor). Cierre sesión e ingrese de nuevo con su cuenta de Apiworking.</Alert>}
      {st.configured && st.read && readOnly && <Alert tone="info" title="Modo de solo lectura">Puede preparar y revisar ventas, pero el envío a Apiworking está desactivado en esta instalación.</Alert>}

      {billing.data && (
        <Alert tone="info" title={`Cobro de ${billing.data.patient.name}`}>
          {billing.data.appointment ? 'Cita atendida. ' : ''}
          {billing.data.customer ? `Cliente en Apiworking: ${billing.data.customer.name}.` : billing.data.identifier ? `${billing.data.identifier.docTypeLabel} ${billing.data.identifier.docNumber}: todavía no es cliente en Apiworking; créelo abajo con «Crear cliente por documento».` : 'El paciente no tiene documento registrado: elija o cree un cliente manualmente.'}
          {billing.data.alreadyBilled && ` Esta cita ya tiene una venta (${billing.data.alreadyBilled.docStatusLabel}).`}
        </Alert>
      )}
      {billing.error != null && <ErrorState error={billing.error} onRetry={billing.reload} />}
      {pendingSale && (
        <Alert tone="warning" title="Emitiendo una venta cobrada en contingencia">
          El dinero ya entró en la caja local: el cliente y el monto no se pueden cambiar. Elija la caja, el tipo de documento, la serie y la forma de pago de Apiworking y confirme la fecha del documento.
          <div style={{ marginTop: 'var(--space-3)', maxWidth: 220 }}><TextField label="Fecha del documento" type="date" value={docDate} onChange={(e) => { setDocDate(e.target.value); setPreview(null); setApproved(false); }} /></div>
          <Button size="sm" variant="tertiary" onClick={reset}>Cancelar la emisión</Button>
        </Alert>
      )}
      {contingency && <Alert tone="warning" title="Modo contingencia">Apiworking no responde. El cobro se guarda aquí y entra en la caja local; el comprobante interno NO es un comprobante de SUNAT: la Boleta o Factura queda pendiente de emitir en Apiworking.</Alert>}

      {canSell && st.read && (session || contingency) && (
        <section className="card" aria-labelledby="new-h" style={{ marginTop: 'var(--space-5)' }}>
          <div className="card-head"><h2 id="new-h" className="h3">Nueva venta</h2></div>

          <h3 className="h3" style={{ margin: 'var(--space-4) 0 var(--space-3)' }}>1. Cliente</h3>
          {customer ? (
            <p>
              <strong>{customer.name}</strong> · <span className="tabular">{customer.docType} {customer.docNumber}</span>{' '}
              <Button size="sm" variant="tertiary" onClick={() => { setCustomer(null); setPreview(null); }}>Cambiar</Button>
            </p>
          ) : (
            <>
              <TextField label="Buscar cliente" help="Por nombre, documento o teléfono. Solo aparecen clientes ya creados en Apiworking." value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" />
              {found.loading && <p className="caption muted"><Search size={14} aria-hidden="true" /> Buscando…</p>}
              {found.error != null && <ErrorState error={found.error} onRetry={found.reload} />}
              {found.data?.offline && <Alert tone="warning">Apiworking no respondió: se muestran solo los clientes guardados en este sistema.</Alert>}
              {found.data && found.data.items.length > 0 && (
                <ul className="context-list">
                  {found.data.items.map((cu) => (
                    <li key={cu.id}><button type="button" onClick={() => setCustomer(cu)}><strong>{cu.name}</strong><span className="caption muted">{cu.docType} {cu.docNumber}</span></button></li>
                  ))}
                </ul>
              )}
              {found.data && found.data.items.length === 0 && !found.loading && <p className="caption muted">No hay clientes que coincidan.</p>}
              <NewCustomer write={st.write} initial={billing.data && !billing.data.customer && billing.data.identifier ? { docType: billing.data.identifier.docType, docNumber: billing.data.identifier.docNumber, name: billing.data.patient.name } : undefined} onCreated={(cu) => { setCustomer(cu); setPreview(null); found.reload(); }} />
            </>
          )}

          {!contingency && (<>
          <h3 className="h3" style={{ margin: 'var(--space-5) 0 var(--space-3)' }}>2. Caja y documento</h3>
          {c && c.cajas.length === 0 && <Alert tone="warning">No hay cajas autorizadas para esta instalación.</Alert>}
          <SelectField label="Caja" value={idCaja} onChange={(e) => { setIdCaja(e.target.value); setIdTipoDocumento(''); setIdSerie(''); setIdMetodoPago(''); }}>
            <option value="">Elija la caja</option>
            {c?.cajas.map((x) => <option key={x.id} value={x.id}>{x.name}{x.branch ? ` · ${x.branch}` : ''}</option>)}
          </SelectField>
          {idCaja && c?.opened === false && <Alert tone="danger">La caja no tiene una apertura vigente en Apiworking. Ábrala allá antes de vender.</Alert>}
          {idCaja && c?.documentTypes && (
            <SelectField label="Tipo de documento" value={idTipoDocumento} onChange={(e) => { setIdTipoDocumento(e.target.value); setIdSerie(''); setIdMetodoPago(''); }}>
              <option value="">Elija el tipo</option>
              {c.documentTypes.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </SelectField>
          )}
          {idTipoDocumento && c?.series && (
            <SelectField label="Serie" value={idSerie} onChange={(e) => setIdSerie(e.target.value)}>
              <option value="">Elija la serie</option>
              {c.series.map((x) => <option key={x.id} value={x.id}>{x.serie}</option>)}
            </SelectField>
          )}
          {idTipoDocumento && c?.paymentMethods && (
            <SelectField label="Forma de pago" help="Un solo método por venta, por el importe completo." value={idMetodoPago} onChange={(e) => setIdMetodoPago(e.target.value)}>
              <option value="">Elija la forma de pago</option>
              {c.paymentMethods.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </SelectField>
          )}

          </>)}

          <h3 className="h3" style={{ margin: 'var(--space-5) 0 var(--space-3)' }}>3. Detalle de la venta o del servicio</h3>
          <TextField label="Descripción" help="Por ejemplo: Limpieza dental y control." value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} />
          {lines.map((l, i) => (
            <div key={i} className="chip-row" style={{ alignItems: 'flex-end', marginBottom: 'var(--space-3)' }}>
              <TextField label={`Concepto ${i + 1}`} value={l.name} onChange={(e) => setLines((all) => all.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} maxLength={120} />
              <TextField label="Cantidad" inputMode="numeric" value={l.quantity} onChange={(e) => setLines((all) => all.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} style={{ width: '6rem' }} />
              <TextField label="Precio unitario (S/)" help="IGV incluido" inputMode="decimal" value={l.price} onChange={(e) => setLines((all) => all.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))} style={{ width: '9rem' }} />
              {lines.length > 1 && <Button size="sm" variant="tertiary" aria-label={`Quitar el concepto ${i + 1}`} icon={<Trash2 size={16} aria-hidden="true" />} onClick={() => setLines((all) => all.filter((_, j) => j !== i))} />}
            </div>
          ))}
          <div className="chip-row">
            <Button size="sm" icon={<Plus size={16} aria-hidden="true" />} onClick={() => setLines((all) => [...all, emptyLine()])} disabled={lines.length >= 30}>Agregar concepto</Button>
            <p className="money" style={{ margin: 0 }}>Total {fmtMoney(total)}</p>
          </div>

          {contingency && customer && (
            <ContingencyBlock customer={customer} description={description.trim()} lines={parsed} validLines={validLines && description.trim().length >= 3} link={link} docDate={docDate} onDone={() => { reset(); sales.reload(); if (urlAppointmentId || urlPatientId) setParams({}, { replace: true }); }} />
          )}

          {!contingency && (<>
          {error && <div style={{ marginTop: 'var(--space-4)' }}><Alert tone="danger">{error}</Alert></div>}
          <div className="chip-row" style={{ marginTop: 'var(--space-5)' }}>
            <Button variant="primary" disabled={!draft || c?.opened === false} loading={busy === 'preview'} loadingText="Preparando…" onClick={() => void review()}>Revisar venta</Button>
            <Button variant="tertiary" onClick={reset}>Limpiar</Button>
          </div>

          {current && (
            <div role="region" aria-label="Revisión antes de enviar" style={{ marginTop: 'var(--space-6)' }}>
              <h3 className="h3">4. Revise antes de enviar</h3>
              <dl className="facts" style={{ margin: 'var(--space-4) 0' }}>
                <dt>Cliente</dt><dd>{current.data.customer.name} · {current.data.customer.docType} {current.data.customer.docNumber}</dd>
                <dt>Documento sugerido</dt><dd>{SUGGESTED[current.data.suggestedDocument]} (según el documento del cliente)</dd>
                <dt>Serie</dt><dd className="tabular">{current.data.serie}</dd>
                <dt>Total</dt><dd className="tabular">{current.data.totalText}</dd>
                <dt>Huella (SHA-256)</dt><dd className="tabular caption" style={{ wordBreak: 'break-all' }}>{current.data.hash}</dd>
              </dl>
              {current.data.warnings.map((w) => <Alert key={w} tone="warning">{w}</Alert>)}
              <details style={{ margin: 'var(--space-4) 0' }}>
                <summary>Ver el JSON exacto que se enviará</summary>
                <pre className="tabular caption" style={{ overflow: 'auto', maxHeight: '22rem' }}>{JSON.stringify(current.data.request, null, 2)}</pre>
              </details>
              <label className="check" style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-start' }}>
                <input type="checkbox" checked={approved} disabled={readOnly} onChange={(e) => setApproved(e.target.checked)} />
                <span>Revisé el documento y autorizo enviarlo a Apiworking. Una Boleta o Factura puede llegar a SUNAT y no se reintenta sola.</span>
              </label>
              <div className="chip-row" style={{ marginTop: 'var(--space-4)' }}>
                <Button variant="primary" icon={<Send size={18} aria-hidden="true" />} disabled={!approved || readOnly} loading={busy === 'send'} loadingText="Enviando…" onClick={() => void send()}>Enviar a Apiworking</Button>
              </div>
            </div>
          )}
          </>)}
        </section>
      )}

      {st.read && session && <CashCard />}

      {can('apiworking:configure') && st.read && session && <DiscoveryCard />}

      <section aria-labelledby="sales-h" style={{ marginTop: 'var(--space-8)' }}>
        <div className="page-head"><h2 id="sales-h" className="h2">Ventas registradas</h2><Button size="sm" icon={<RefreshCw size={16} aria-hidden="true" />} onClick={sales.reload}>Actualizar</Button></div>
        {sales.loading && !sales.data && <Loading rows={3} />}
        {sales.error != null && <ErrorState error={sales.error} onRetry={sales.reload} />}
        {sales.data?.items.length === 0 && <EmptyState title="Todavía no hay ventas">Las ventas que envíe a Apiworking aparecerán aquí.</EmptyState>}
        {sales.data && sales.data.items.length > 0 && (
          <div className="table-wrap table-cards">
            <table>
              <caption className="sr-only">Ventas enviadas a Apiworking</caption>
              <thead><tr><th scope="col">Fecha</th><th scope="col">Cliente</th><th scope="col">Detalle</th><th scope="col" className="num">Total</th><th scope="col">Documento</th><th scope="col">Cobro</th><th scope="col">Acciones</th></tr></thead>
              <tbody>
                {sales.data.items.map((s) => (
                  <tr key={s.id}>
                    <td data-label="Fecha" className="tabular">{fmtDateTime(s.createdAt)}</td>
                    <td data-label="Cliente">{s.customer.name}</td>
                    <td data-label="Detalle">{s.description}{s.externalNumber && <><br /><span className="caption tabular">{s.externalNumber}</span></>}</td>
                    <td data-label="Total" className="num">{s.totalText}</td>
                    <td data-label="Documento">
                      <Badge tone={DOC_TONE[s.docStatus]}>{s.docStatusLabel}</Badge>
                      {s.voidStatusLabel && <><br /><Badge tone="neutral">{s.voidStatusLabel}</Badge></>}
                      {s.failureReason && <p className="caption muted">{s.failureReason}</p>}
                    </td>
                    <td data-label="Cobro"><Badge tone={PAY_TONE[s.paymentStatus]}>{s.paymentStatusLabel}</Badge></td>
                    <td data-label="Acciones">
                      <div className="chip-row">
                        {s.actions.issue && canSell && !readOnly && <Button size="sm" variant="primary" onClick={() => startIssue(s)}>Emitir en Apiworking</Button>}
                        {s.actions.verify && canSell && <Button size="sm" loading={rowBusy === s.id} loadingText="Consultando…" onClick={() => void verify(s)}>Verificar</Button>}
                        {s.actions.reconcile && canSell && <Button size="sm" onClick={() => setReconcileOf(s)}>Conciliar</Button>}
                        {s.actions.void && can('apiworking:void') && !readOnly && <Button size="sm" variant="danger" onClick={() => setVoidOf(s)}>Anular</Button>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {verifyResult && <VerifyDialog result={verifyResult} onClose={() => setVerifyResult(null)} />}
      {reconcileOf && <ReconcileDialog sale={reconcileOf} onClose={() => setReconcileOf(null)} onDone={() => { setReconcileOf(null); sales.reload(); toast.success('Venta conciliada.'); }} />}
      {voidOf && (
        <ReasonDialog
          title="Anular venta en Apiworking" danger confirmLabel="Anular venta" example="Error en el monto"
          explain={`Se pedirá a Apiworking anular ${voidOf.externalNumber ?? 'este documento'} por ${voidOf.totalText}. Después se verifica el resultado.`}
          onClose={() => setVoidOf(null)}
          onConfirm={async (reason) => { await post(`/apiworking/sales/${voidOf.id}/void`, { reason }); setVoidOf(null); sales.reload(); toast.success('Anulación enviada. Verifíquela para confirmarla.'); }}
        />
      )}
    </>
  );
}

function VerifyDialog({ result, onClose }: { result: AwVerify; onClose: () => void }) {
  const s = result.sale;
  return (
    <Dialog title="Resultado de la verificación" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Entendido</Button>}>
      <p><strong>{s.docStatusLabel}</strong> · {s.paymentStatusLabel}{s.voidStatusLabel ? ` · ${s.voidStatusLabel}` : ''}</p>
      {result.paidCents !== undefined && <p>Pagos informados por Apiworking: {fmtMoney(result.paidCents)} de {s.totalText}.</p>}
      {result.paymentMessage && <Alert tone="info">Apiworking respondió: «{result.paymentMessage}». El cobro sigue sin confirmar.</Alert>}
      {result.candidates && (
        result.candidates.length === 0
          ? <Alert tone="warning">No se encontró en Apiworking un documento con el mismo total y fecha. Si está seguro de que no existe, concilie la venta como «no registrada».</Alert>
          : (
            <>
              <p>Documentos de Apiworking con el mismo total y fecha. Confirme cuál es y concilie con su número:</p>
              <ul>{result.candidates.map((cd) => <li key={cd.number} className="tabular">{cd.number} · {cd.status}</li>)}</ul>
            </>
          )
      )}
    </Dialog>
  );
}

function ReconcileDialog({ sale, onClose, onDone }: { sale: AwSale; onClose: () => void; onDone: () => void }) {
  const [outcome, setOutcome] = useState<'REGISTERED' | 'NOT_REGISTERED'>('REGISTERED');
  const [number, setNumber] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invalid = note.trim().length < 3 || (outcome === 'REGISTERED' && !number.trim());
  const submit = async () => {
    if (invalid) return;
    setBusy(true); setError(null);
    try {
      await post(`/apiworking/sales/${sale.id}/reconcile`, { outcome, note: note.trim(), ...(outcome === 'REGISTERED' ? { externalNumber: number.trim() } : {}) });
      onDone();
    } catch (e) { setError(errorText(e)); setBusy(false); }
  };
  return (
    <Dialog title="Conciliar resultado desconocido" onClose={onClose} footer={<><Button onClick={onClose}>Volver</Button><Button variant="primary" loading={busy} loadingText="Guardando…" disabled={invalid} onClick={() => void submit()}>Guardar decisión</Button></>}>
      <p className="muted">Esta decisión es suya y queda auditada. No se reenvía nada a Apiworking: verifique primero en su sistema si el documento existe.</p>
      {error && <Alert tone="danger">{error}</Alert>}
      <SelectField label="¿Qué encontró en Apiworking?" value={outcome} onChange={(e) => setOutcome(e.target.value as typeof outcome)}>
        <option value="REGISTERED">El documento SÍ existe</option>
        <option value="NOT_REGISTERED">El documento NO existe</option>
      </SelectField>
      {outcome === 'REGISTERED' && <TextField label="Número de comprobante" help="Tal como aparece en Apiworking, por ejemplo B001-00000123." value={number} onChange={(e) => setNumber(e.target.value)} maxLength={40} />}
      <TextField label="Nota" help="Cómo lo verificó. Mínimo 3 caracteres." value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
    </Dialog>
  );
}

/** Solo administradores: todo lo que Apiworking informa (cajas, documentos, series), para decidir qué autorizar en el servidor. */
function DiscoveryCard() {
  const [idCaja, setIdCaja] = useState('');
  const [idTipo, setIdTipo] = useState('');
  const d = useAsync(() => get<AwDiscovery>('/apiworking/discovery', { idCaja, idTipoDocumento: idTipo }), [idCaja, idTipo]);
  const x = d.data;
  const Mark = ({ ok }: { ok: boolean }) => <Badge tone={ok ? 'success' : 'neutral'}>{ok ? 'Autorizada' : 'No autorizada'}</Badge>;
  const env = [
    idCaja && `APIWORKING_AUTHORIZED_CASH_REGISTERS=${idCaja}`,
    idTipo && `APIWORKING_AUTHORIZED_DOCUMENT_TYPES=${idTipo}`,
    idTipo && x?.series && x.series.length > 0 && `APIWORKING_AUTHORIZED_SERIES=${x.series.map((s) => s.id).join(',')}`,
  ].filter(Boolean).join('\n');
  return (
    <section className="card" aria-labelledby="disc-h" style={{ marginTop: 'var(--space-8)' }}>
      <div className="card-head"><h2 id="disc-h" className="h3">Configuración de Apiworking</h2><Badge tone="info">Solo lectura</Badge></div>
      <p className="muted">Lo que Apiworking informa para este tenant. Elija una caja y un tipo de documento para ver sus ids y cuáles están autorizados en el servidor. No se modifica nada desde aquí.</p>
      {d.error != null && <ErrorState error={d.error} onRetry={d.reload} />}
      {x && (
        <>
          <SelectField label="Caja" value={idCaja} onChange={(e) => { setIdCaja(e.target.value); setIdTipo(''); }}>
            <option value="">Elija una caja</option>
            {x.cajas.map((c) => <option key={c.id} value={c.id}>{c.name} · id {c.id}{c.authorized ? ' (autorizada)' : ''}</option>)}
          </SelectField>
          {idCaja && x.opened === false && <Alert tone="warning">Esta caja no tiene una apertura vigente en Apiworking.</Alert>}
          {idCaja && x.documentTypes && (
            <SelectField label="Tipo de documento" value={idTipo} onChange={(e) => setIdTipo(e.target.value)}>
              <option value="">Elija un tipo</option>
              {x.documentTypes.map((t) => <option key={t.id} value={t.id}>{t.name} · id {t.id}{t.authorized ? ' (autorizado)' : ''}</option>)}
            </SelectField>
          )}
          {idTipo && x.series && (
            <div className="table-wrap table-cards">
              <table>
                <caption className="sr-only">Series del tipo de documento</caption>
                <thead><tr><th scope="col">Serie</th><th scope="col">Id</th><th scope="col">Estado</th></tr></thead>
                <tbody>{x.series.map((s) => <tr key={s.id}><td data-label="Serie">{s.serie}</td><td data-label="Id" className="tabular">{s.id}</td><td data-label="Estado"><Mark ok={s.authorized} /></td></tr>)}</tbody>
              </table>
            </div>
          )}
          {idTipo && x.paymentMethods && x.paymentMethods.length > 0 && <p className="caption muted">Formas de pago de la apertura: {x.paymentMethods.map((m) => `${m.name} (id ${m.id})`).join(', ')}.</p>}
          {env && (
            <div style={{ marginTop: 'var(--space-4)' }}>
              <p className="caption muted">Valores para el servidor (los aplica quien administra la instalación):</p>
              <pre className="tabular caption" style={{ overflow: 'auto' }}>{env}</pre>
              <p className="caption muted">Opcional: sin estas listas vale lo que Apiworking informa al usuario. Para vender se usa como almacén la sucursal del usuario{x.warehouseId ? ` (${x.warehouseId})` : ''} y como unidad de medida {x.unitId ?? '1'} (NIU).</p>
            </div>
          )}
        </>
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
      {x && x.cajas.length === 0 && <p className="muted">No hay cajas autorizadas en esta instalación. Un administrador puede verlas en «Configuración de Apiworking».</p>}
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

/** Alta de cliente por documento (ClienteDoc): vista previa, aprobación explícita y un solo envío. */
function NewCustomer({ write, initial, onCreated }: { write: boolean; initial?: { docType: string; docNumber: string; name: string }; onCreated: (c: AwCustomer) => void }) {
  const toast = useToast();
  const [openForm, setOpenForm] = useState(Boolean(initial));
  const [docType, setDocType] = useState(initial?.docType ?? '1');
  const [docNumber, setDocNumber] = useState(initial?.docNumber ?? '');
  const [name, setName] = useState(initial?.name ?? '');
  const [prev, setPrev] = useState<{ data: AwCustomerPreview; signature: string } | null>(null);
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState<'preview' | 'create' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const sending = useRef(false);
  const signature = `${docType}|${docNumber.trim()}`;
  const current = prev && prev.signature === signature ? prev : null;
  useEffect(() => { if (prev && prev.signature !== signature) setOk(false); }, [prev, signature]);

  const review = async () => {
    setBusy('preview'); setError(null); setOk(false); setNote(null);
    try { setPrev({ data: await post<AwCustomerPreview>('/apiworking/clients/preview', { docType, docNumber: docNumber.trim() }), signature }); }
    catch (e) { setError(errorText(e)); setPrev(null); }
    finally { setBusy(null); }
  };
  const create = async () => {
    if (!current || sending.current) return;
    sending.current = true; setBusy('create'); setError(null);
    try {
      const r = await post<AwCustomerResult>('/apiworking/clients', { docType, docNumber: docNumber.trim(), approvedHash: current.data.hash, ...(name.trim() ? { name: name.trim() } : {}) });
      if (r.status === 'CREATED' && r.customer) { toast.success('Cliente creado'); onCreated(r.customer); setOpenForm(false); setDocNumber(''); setName(''); setPrev(null); setOk(false); }
      else setNote(r.status === 'CREATED' ? 'Cliente creado. Búsquelo en la lista para elegirlo.' : r.message ?? 'No se pudo confirmar el alta. Búsquelo antes de intentarlo de nuevo.');
    } catch (e) { setError(errorText(e)); }
    finally { sending.current = false; setBusy(null); }
  };

  if (!openForm) return <p><Button size="sm" variant="tertiary" icon={<Plus size={16} aria-hidden="true" />} onClick={() => setOpenForm(true)}>Crear cliente por documento</Button></p>;
  return (
    <div className="card" style={{ marginTop: 'var(--space-4)' }}>
      <h4 className="h3">Nuevo cliente</h4>
      <SelectField label="Tipo de documento" value={docType} onChange={(e) => setDocType(e.target.value)}>
        <option value="1">DNI</option><option value="6">RUC</option><option value="4">Carné de extranjería</option><option value="7">Pasaporte</option><option value="0">No domiciliado</option>
      </SelectField>
      <TextField label="Número de documento" value={docNumber} inputMode="text" autoComplete="off" onChange={(e) => setDocNumber(e.target.value)} />
      {error && <Alert tone="danger">{error}</Alert>}
      {note && <Alert tone="warning">{note}</Alert>}
      <div className="chip-row">
        <Button variant="secondary" disabled={docNumber.trim().length === 0} loading={busy === 'preview'} loadingText="Preparando…" onClick={() => void review()}>Revisar</Button>
        <Button variant="tertiary" onClick={() => { setOpenForm(false); setPrev(null); setError(null); }}>Cancelar</Button>
      </div>
      {current && current.data.exists && <Alert tone="warning">Este documento ya existe en Apiworking ({current.data.exists.name}). Búsquelo en la lista para elegirlo.</Alert>}
      {current && !current.data.exists && (
        <div style={{ marginTop: 'var(--space-4)' }}>
          <p>Se creará un cliente con <strong>{current.data.docTypeLabel} {current.data.docNumber}</strong> en Apiworking. Apiworking completa su propio nombre; el de abajo es solo la referencia que se guarda aquí.</p>
          <TextField label="Nombre (opcional)" value={name} autoComplete="off" onChange={(e) => setName(e.target.value)} />
          {!write && <Alert tone="info">Las escrituras reales están desactivadas en esta instalación.</Alert>}
          <label className="check" style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-start' }}>
            <input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} />
            <span>Revisé el documento y autorizo crear este cliente en Apiworking. No se reintenta sola.</span>
          </label>
          <div className="chip-row" style={{ marginTop: 'var(--space-4)' }}>
            <Button variant="primary" disabled={!ok || !write} loading={busy === 'create'} loadingText="Creando…" onClick={() => void create()}>Crear cliente</Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Cobro en contingencia: se guarda la venta «por emitir» y el dinero entra en la caja LOCAL. No se llama a Apiworking. */
function ContingencyBlock({ customer, description, lines, validLines, link, docDate, onDone }: {
  customer: AwCustomer; description: string; lines: { name: string; quantity: number; cents: number | null }[]; validLines: boolean;
  link: { appointmentId?: string; patientId?: string }; docDate: string; onDone: () => void;
}) {
  const toast = useToast();
  const cfg = useAsync(() => get<CashConfig>('/cashbox/config'), []);
  const summary = useAsync(() => get<CashSummary>('/cashbox/summary'), []);
  const [accountId, setAccountId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(crypto.randomUUID());
  const accounts = cfg.data?.accounts.filter((a) => a.active) ?? [];
  const categories = cfg.data?.categories.filter((x) => x.flow === 'INCOME' && x.active) ?? [];
  const closed = summary.data ? summary.data.session === null : false;
  const total = lines.reduce((s, l) => s + (l.cents ?? 0) * l.quantity, 0);

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      await post('/apiworking/contingency', {
        customerId: customer.id, description, accountId, categoryId, requestKey: key.current,
        lines: lines.map((l) => ({ name: l.name, quantity: l.quantity, unitPriceCents: l.cents! })),
        ...(link.appointmentId ? { appointmentId: link.appointmentId } : {}), ...(link.patientId ? { patientId: link.patientId } : {}), ...(docDate ? { docDate } : {}),
      });
      toast.success('Cobro registrado en la caja local. El documento queda por emitir en Apiworking.');
      key.current = crypto.randomUUID();
      onDone();
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="card" style={{ marginTop: 'var(--space-5)' }}>
      <h3 className="h3">4. Cobrar en la caja local</h3>
      {closed && <Alert tone="danger">La caja local está cerrada. <Link to="/caja">Ábrala en Caja</Link> antes de cobrar en contingencia.</Alert>}
      <SelectField label="Cuenta o medio de pago" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
        <option value="">Elija la cuenta</option>
        {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
      </SelectField>
      <SelectField label="Tipo de operación" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
        <option value="">Elija el tipo</option>
        {categories.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
      </SelectField>
      <p>Se cobrarán <strong>{fmtMoney(total)}</strong> a <strong>{customer.name}</strong>.</p>
      <label className="check" style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-start' }}>
        <input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} />
        <span>Apiworking no responde: autorizo cobrar en la caja local. El comprobante de SUNAT queda pendiente de emitir.</span>
      </label>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="chip-row" style={{ marginTop: 'var(--space-4)' }}>
        <Button variant="primary" disabled={!ok || !validLines || !accountId || !categoryId || closed} loading={busy} loadingText="Registrando…" onClick={() => void submit()}>Registrar cobro en contingencia</Button>
      </div>
    </div>
  );
}
