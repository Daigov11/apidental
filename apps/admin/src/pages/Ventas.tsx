import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Banknote, CreditCard, Landmark, Plus, RefreshCw, Search, Send, Smartphone, Trash2, Wallet } from 'lucide-react';
import { get, post } from '../api/client';
import type { AwBillingDraft, AwCustomerPreview, AwCustomerResult, AwContext, AwCustomer, AwDiscovery, AwDraft, AwLine, AwPreview, AwSale, AwStatus, AwVerify, CashConfig, CashSummary } from '../api/types';
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
  // Lo que solo tiene una opción se elige solo; la forma de pago arranca en Efectivo (o la primera) y se cambia con un toque.
  useEffect(() => {
    if (!c || ctx.loading) return;
    if (!idCaja && c.cajas.length === 1) setIdCaja(c.cajas[0]!.id);
    else if (idCaja && !idTipoDocumento && c.documentTypes?.length === 1) setIdTipoDocumento(c.documentTypes[0]!.id);
    else if (idTipoDocumento && !idSerie && c.series?.length === 1) setIdSerie(c.series[0]!.id);
    if (idTipoDocumento && !idMetodoPago && c.paymentMethods && c.paymentMethods.length > 0) setIdMetodoPago((c.paymentMethods.find((m) => /efectivo/i.test(m.name)) ?? c.paymentMethods[0]!).id);
  }, [c, ctx.loading, idCaja, idTipoDocumento, idSerie, idMetodoPago]);

  // --- Detalle ---
  const [lines, setLines] = useState<LineField[]>([emptyLine()]);
  const parsed = useMemo(() => lines.map((l) => ({ name: l.name.trim(), quantity: Number(l.quantity), cents: parseSoles(l.price) })), [lines]);
  const validLines = parsed.every((l) => l.name.length >= 2 && Number.isInteger(l.quantity) && l.quantity >= 1 && l.quantity <= 999 && l.cents !== null && l.cents > 0);
  // La descripción del documento sale de los conceptos (o es la de la venta que se está emitiendo): no se pide aparte.
  const description = pendingSale ? pendingSale.description : parsed.map((l) => l.name).filter(Boolean).join(', ').slice(0, 200);
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

  const reset = () => { setPendingSale(null); setDocDate(''); setCustomer(null); setQuery(''); setLines([emptyLine()]); setPreview(null); setApproved(false); setIdSerie(''); setIdMetodoPago(''); };
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
  const [payOf, setPayOf] = useState<AwSale | null>(null);
  const [payBusy, setPayBusy] = useState(false);
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
        <div><h1>Nueva venta</h1><p className="muted">Registra una venta o cobra una cita. Tenant: <span className="tabular">{st.tenant ?? '—'}</span></p></div>
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
        <>
        <div className="sale-layout" style={{ marginTop: 'var(--space-5)' }}>
          <div className="sale-main">
            <section className="card" aria-labelledby="cli-h">
              <div className="card-head"><h2 id="cli-h" className="h3">Cliente</h2></div>
              {customer ? (
                <p>
                  <strong>{customer.name}</strong> · <span className="tabular">{customer.docType} {customer.docNumber}</span>{' '}
                  <Button size="sm" variant="tertiary" onClick={() => { setCustomer(null); setPreview(null); }}>Cambiar</Button>
                </p>
              ) : (
                <>
                  <TextField label="Buscar cliente" help="Por nombre, documento o teléfono." value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" />
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
                  <NewCustomer key={billing.data?.identifier?.docNumber ?? 'manual'} write={st.write} initial={billing.data && !billing.data.customer && billing.data.identifier ? { docType: billing.data.identifier.docType, docNumber: billing.data.identifier.docNumber, name: billing.data.patient.name } : undefined} onCreated={(cu) => { setCustomer(cu); setPreview(null); found.reload(); }} />
                </>
              )}
            </section>

            {!contingency && (
              <section className="card" aria-labelledby="doc-h">
                <div className="card-head"><h2 id="doc-h" className="h3">Comprobante</h2></div>
                {c && c.cajas.length === 0 && <Alert tone="warning">No hay cajas autorizadas para esta instalación.</Alert>}
                {idCaja && c?.opened === false && <Alert tone="danger">La caja no tiene una apertura vigente en Apiworking. Ábrala en «Caja chica» antes de vender.</Alert>}
                <div className="row-2">
                  {c && c.cajas.length > 1 && (
                    <SelectField label="Caja" value={idCaja} onChange={(e) => { setIdCaja(e.target.value); setIdTipoDocumento(''); setIdSerie(''); setIdMetodoPago(''); }}>
                      <option value="">Elija la caja</option>
                      {c.cajas.map((x) => <option key={x.id} value={x.id}>{x.name}{x.branch ? ` · ${x.branch}` : ''}</option>)}
                    </SelectField>
                  )}
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
                </div>
              </section>
            )}

            <section className="card" aria-labelledby="det-h">
              <div className="card-head"><h2 id="det-h" className="h3">Detalle de venta</h2><span className="caption muted">{lines.length} {lines.length === 1 ? 'concepto' : 'conceptos'}</span></div>
              {lines.map((l, i) => (
                <div key={i} className="chip-row" style={{ alignItems: 'flex-end', marginBottom: 'var(--space-3)' }}>
                  <TextField label={`Concepto ${i + 1}`} value={l.name} onChange={(e) => setLines((all) => all.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} maxLength={120} />
                  <TextField label="Cantidad" inputMode="numeric" value={l.quantity} onChange={(e) => setLines((all) => all.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} style={{ width: '6rem' }} />
                  <TextField label="Precio unitario (S/)" help="IGV incluido" inputMode="decimal" value={l.price} onChange={(e) => setLines((all) => all.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))} style={{ width: '9rem' }} />
                  {lines.length > 1 && <Button size="sm" variant="tertiary" aria-label={`Quitar el concepto ${i + 1}`} icon={<Trash2 size={16} aria-hidden="true" />} onClick={() => setLines((all) => all.filter((_, j) => j !== i))} />}
                </div>
              ))}
              <Button size="sm" icon={<Plus size={16} aria-hidden="true" />} onClick={() => setLines((all) => [...all, emptyLine()])} disabled={lines.length >= 30}>Agregar concepto</Button>
            </section>
          </div>

          <aside className="card sale-side" aria-labelledby="sum-h">
            <h2 id="sum-h" className="h3">Resumen de venta</h2>
            <p className="muted" style={{ margin: 'var(--space-4) 0 0' }}>Importe total</p>
            <p className="money sale-total">{fmtMoney(total)}</p>
            <p className="caption muted">IGV incluido</p>
            {!contingency && idTipoDocumento && c?.paymentMethods && (
              <fieldset className="pay-options">
                <legend className="h3">Forma de pago</legend>
                {c.paymentMethods.map((m) => (
                  <button key={m.id} type="button" className="pay-option" aria-pressed={idMetodoPago === m.id} onClick={() => setIdMetodoPago(m.id)}>
                    <PayIcon name={m.name} /> <span>{m.name}</span>
                  </button>
                ))}
              </fieldset>
            )}
            {contingency && customer && (
              <ContingencyBlock customer={customer} description={description} lines={parsed} validLines={validLines && description.length >= 3} link={link} docDate={docDate} onDone={() => { reset(); sales.reload(); if (urlAppointmentId || urlPatientId) setParams({}, { replace: true }); }} />
            )}
            {!contingency && (
              <>
                {error && <Alert tone="danger">{error}</Alert>}
                <Button variant="primary" disabled={!draft || c?.opened === false} loading={busy === 'preview'} loadingText="Preparando…" onClick={() => void review()}>Revisar venta</Button>
                <Button variant="tertiary" onClick={reset}>Limpiar venta</Button>
              </>
            )}
          </aside>
        </div>

        {!contingency && current && (
          <section className="card" role="region" aria-label="Revisión antes de enviar" style={{ marginTop: 'var(--space-5)' }}>
            <h2 className="h3">Revise antes de enviar</h2>
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
          </section>
        )}
        </>
      )}

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
                        {s.actions.pay && canSell && !readOnly && <Button size="sm" variant="primary" onClick={() => setPayOf(s)}>Registrar pago</Button>}
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
      {payOf && (
        <Dialog
          title="Registrar el pago en Apiworking" onClose={() => (payBusy ? undefined : setPayOf(null))}
          footer={<><Button onClick={() => setPayOf(null)} disabled={payBusy}>Volver</Button><Button variant="primary" loading={payBusy} loadingText="Enviando…" onClick={async () => {
            setPayBusy(true);
            try { await post(`/apiworking/sales/${payOf.id}/pay`); setPayOf(null); toast.success('Pago registrado en Apiworking.'); }
            catch (e) { toast.error(errorText(e)); setPayOf(null); }
            finally { setPayBusy(false); sales.reload(); }
          }}>Registrar pago</Button></>}
        >
          <p>Se enviará a Apiworking el pago de <strong>{payOf.externalNumber ?? 'este documento'}</strong> por <strong>{payOf.totalText}</strong>, a nombre de {payOf.customer.name}.</p>
          <p className="muted">Se envía una sola vez, sin vuelto. Si el resultado no se confirma, use «Verificar» antes de intentarlo de nuevo.</p>
        </Dialog>
      )}
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

function PayIcon({ name }: { name: string }) {
  const p = { size: 20, 'aria-hidden': true } as const;
  if (/efectivo/i.test(name)) return <Banknote {...p} />;
  if (/tarjeta|visa|master/i.test(name)) return <CreditCard {...p} />;
  if (/yape|plin|billetera/i.test(name)) return <Smartphone {...p} />;
  if (/transfer|banco|dep[oó]sito/i.test(name)) return <Landmark {...p} />;
  return <Wallet {...p} />;
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
