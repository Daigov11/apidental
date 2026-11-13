import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Banknote, CreditCard, Landmark, Plus, RefreshCw, Search, Smartphone, Trash2, Wallet } from 'lucide-react';
import { get, post } from '../api/client';
import type { AwBillingDraft, AwBillingPrescription, Product, AwCustomerPreview, AwCustomerResult, AwContext, AwCustomer, AwDraft, AwLine, AwSale, AwStatus, CashConfig, CashSummary } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { fmtDateTime } from '../lib/format';
import { fmtMoney, parseSoles } from '../lib/money';
import { useAsync } from '../lib/useAsync';
import { Button } from '../ui/Button';
import { SelectField, TextField } from '../ui/fields';
import { Alert, Badge, EmptyState, ErrorState, Loading, errorText, useToast } from '../ui/feedback';
import { ReasonDialog } from '../ui/overlays';

/** Un concepto de la venta. `serviceIds`: viene de la cuenta pendiente (lo que hizo el odontólogo) y se cobra con ella. */
interface LineField { name: string; quantity: string; price: string; serviceIds?: string[] }
const emptyLine = (): LineField => ({ name: '', quantity: '1', price: '' });
const DOC_TONE = { PENDING_ISSUE: 'warning', PENDING: 'info', SENT: 'success', REJECTED: 'danger', PENDING_RECONCILIATION: 'warning' } as const;
const PAY_TONE = { NO_EVIDENCE: 'neutral', CONFIRMED_REMOTE: 'success', CONFIRMED_RECONCILED: 'success' } as const;

/** Venta directa en Apiworking: con la caja de la sesión, «Cobrar» registra el documento y aplica el pago en un solo paso. */
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
  const urlDocument = params.get('dni') ?? undefined;
  // Contingencia: Apiworking no responde; el cobro entra en la caja local y el documento queda por emitir.
  const [contingency, setContingency] = useState(false);
  // Venta cobrada en contingencia que se está emitiendo ahora (completa ESA fila).
  const [pendingSale, setPendingSale] = useState<AwSale | null>(null);
  const [docDate, setDocDate] = useState('');
  const billing = useAsync(
    () => (urlAppointmentId || urlPatientId || urlDocument ? get<AwBillingDraft>('/apiworking/billing-draft', { appointmentId: urlAppointmentId, patientId: urlPatientId, document: urlDocument }) : Promise.resolve(null)),
    [urlAppointmentId, urlPatientId, urlDocument],
  );
  const fromUrl = Boolean(urlAppointmentId || urlPatientId || urlDocument);
  const b0 = billing.data;
  const link = pendingSale
    ? { appointmentId: pendingSale.appointmentId ?? undefined, patientId: pendingSale.patientId ?? undefined }
    : b0
      ? { appointmentId: b0.appointment && b0.canBill && !b0.alreadyBilled ? b0.appointment.id : undefined, patientId: b0.patient.id }
      : { appointmentId: urlAppointmentId, patientId: urlPatientId };
  const [dni, setDni] = useState('');

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
    if (!idCaja && c.cajas.length > 0) setIdCaja(c.cajas[0]!.id);
    else if (idCaja && !idTipoDocumento && c.documentTypes?.length === 1) setIdTipoDocumento(c.documentTypes[0]!.id);
    else if (idTipoDocumento && !idSerie && c.series?.length === 1) setIdSerie(c.series[0]!.id);
    if (idTipoDocumento && !idMetodoPago && c.paymentMethods && c.paymentMethods.length > 0) setIdMetodoPago((c.paymentMethods.find((m) => /efectivo/i.test(m.name)) ?? c.paymentMethods[0]!).id);
  }, [c, ctx.loading, idCaja, idTipoDocumento, idSerie, idMetodoPago]);

  // --- Detalle ---
  const [lines, setLines] = useState<LineField[]>([emptyLine()]);
  const catalog = useAsync(() => (canSell ? get<Product[]>('/products') : Promise.resolve([] as Product[])), [canSell]);
  /** Agrega un concepto (sin repetir): si el único concepto está vacío, lo reemplaza. */
  const addLine = (name: string, priceCents?: number | null) => setLines((all) => {
    if (all.some((l) => l.name.trim() === name) || all.length >= 30) return all;
    const line = { name, quantity: '1', price: priceCents ? (priceCents / 100).toFixed(2) : '' };
    return all.length === 1 && !all[0]!.name.trim() && !all[0]!.price.trim() ? [line] : [...all, line];
  });
  const parsed = useMemo(() => lines.map((l) => ({ name: l.name.trim(), quantity: Number(l.quantity), cents: parseSoles(l.price) })), [lines]);
  const validLines = parsed.every((l) => l.name.length >= 2 && Number.isInteger(l.quantity) && l.quantity >= 1 && l.quantity <= 999 && l.cents !== null && l.cents > 0);
  // La descripción del documento sale de los conceptos (o es la de la venta que se está emitiendo): no se pide aparte.
  const description = pendingSale ? pendingSale.description : parsed.map((l) => l.name).filter(Boolean).join(', ').slice(0, 200);
  const total = parsed.reduce((s, l) => s + (l.cents ?? 0) * (Number.isFinite(l.quantity) ? l.quantity : 0), 0);
  // Descuento (S/) sobre el total y pago con varios medios.
  const [discount, setDiscount] = useState('');
  const discountCents = discount.trim() ? parseSoles(discount) : 0;
  const net = total - (discountCents ?? 0);
  const discountOk = discountCents !== null && discountCents >= 0 && discountCents < total;
  const [split, setSplit] = useState<{ id: string; amount: string }[] | null>(null);
  const splitParts = split?.map((p) => ({ idMetodoPago: p.id, amountCents: parseSoles(p.amount) })) ?? [];
  const splitSum = splitParts.reduce((t, p) => t + (p.amountCents ?? 0), 0);
  const splitOk = !split || (split.length >= 2 && splitParts.every((p) => p.idMetodoPago && p.amountCents !== null && p.amountCents > 0) && new Set(split.map((p) => p.id)).size === split.length && splitSum === net);
  // Lo que se cobra de la cuenta pendiente: solo las líneas de la atención que siguen en la venta.
  const accountIds = pendingSale ? [] : lines.flatMap((l) => l.serviceIds ?? []);

  const mainMethod = split ? (split[0]?.id ?? '') : idMetodoPago;
  const draft: AwDraft | null = customer && idCaja && idTipoDocumento && idSerie && mainMethod && description.trim().length >= 3 && validLines && discountOk && splitOk
    ? {
      customerId: customer.id, idCaja, idTipoDocumento, idSerie, idMetodoPago: mainMethod, description: description.trim(),
      ...(discountCents ? { discountCents } : {}),
      ...(split ? { payments: splitParts.map((p) => ({ idMetodoPago: p.idMetodoPago, amountCents: p.amountCents! })) } : {}), lines: parsed.map((l): AwLine => ({ name: l.name, quantity: l.quantity, unitPriceCents: l.cents! })),
      ...(link.appointmentId ? { appointmentId: link.appointmentId } : {}), ...(link.patientId ? { patientId: link.patientId } : {}),
      ...(pendingSale ? { pendingSaleId: pendingSale.id } : {}), ...(docDate ? { docDate } : {}),
      ...(accountIds.length ? { visitServiceIds: accountIds } : {}),
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
    // Consulta (servicio de la cita) + lo que hizo el odontólogo (cuenta pendiente), agrupado: «Curación (piezas 16, 26)» × 2.
    const next: LineField[] = [];
    if (b.description && b.amountCents && b.appointment && b.canBill && !b.alreadyBilled) next.push({ name: b.description, quantity: '1', price: (b.amountCents / 100).toFixed(2) });
    for (const it of b.account?.items ?? []) {
      next.push({ name: `${it.name}${it.teeth.length ? ` (piezas ${it.teeth.join(', ')})` : ''}`.slice(0, 120), quantity: String(it.quantity), price: (it.unitPriceCents / 100).toFixed(2), serviceIds: it.serviceIds });
    }
    if (next.length) setLines(next.slice(0, 30));
  }, [billing.data]);

  // --- Venta directa: un clic registra el documento y aplica el pago ---
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reset = () => { setPendingSale(null); setDocDate(''); setCustomer(null); setQuery(''); setLines([emptyLine()]); setIdSerie(''); setIdMetodoPago(''); setError(null); setDiscount(''); setSplit(null); };
  // Una sola clave por venta: un doble clic o un reintento de red no registra dos veces la misma venta.
  const key = useRef<{ signature: string; key: string } | null>(null);
  const sending = useRef(false);
  const sell = async () => {
    if (!draft || sending.current) return;
    sending.current = true;
    setBusy(true); setError(null);
    if (key.current?.signature !== signature) key.current = { signature, key: crypto.randomUUID() };
    try {
      const sale = await post<AwSale>('/apiworking/sales', { ...draft, idempotencyKey: key.current.key });
      const num = sale.externalNumber ? ` ${sale.externalNumber}` : '';
      if (sale.docStatus === 'SENT' && sale.paymentStatus !== 'NO_EVIDENCE') toast.success(`Venta${num} registrada y pagada en Apiworking.`);
      else if (sale.docStatus === 'SENT') toast.error(`Venta${num} registrada en Apiworking, pero el pago no se aplicó${sale.failureReason ? `: ${sale.failureReason.replace(/^Pago no aplicado en Apiworking: /, '')}` : ''}.`);
      else if (sale.docStatus === 'PENDING_RECONCILIATION') toast.success('Venta enviada a Apiworking. Su número aparecerá en la lista en unos momentos.');
      else { setError(`Apiworking rechazó la venta: ${sale.failureReason ?? 'sin detalle'}`); return; }
      key.current = null;
      reset();
      if (fromUrl) setParams({}, { replace: true });
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); sending.current = false; sales.reload(); status.reload(); }
  };

  // --- Acciones sobre ventas ---
  const [voidOf, setVoidOf] = useState<AwSale | null>(null);

  const startIssue = (s: AwSale) => {
    setContingency(false); setPendingSale(s); setIdTipoDocumento(''); setIdSerie(''); setIdMetodoPago('');
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
          <Button size="sm" variant={contingency ? 'primary' : 'tertiary'} onClick={() => { setContingency((v) => !v); setPendingSale(null); }}>
            {contingency ? 'Salir de contingencia' : 'Apiworking no responde: cobrar en contingencia'}
          </Button>
        )}
      </div>
      {!st.configured && <Alert tone="warning" title="Apiworking no está configurado">Esta instalación no tiene el tenant de Apiworking configurado.</Alert>}
      {st.configured && !st.read && <Alert tone="warning" title="Lecturas desactivadas">Las consultas reales a Apiworking están apagadas en esta instalación.</Alert>}
      {st.configured && st.read && !session && <Alert tone="warning" title="Vuelva a ingresar">Su sesión de Apiworking ya no está disponible (por ejemplo, tras reiniciar el servidor). Cierre sesión e ingrese de nuevo con su cuenta de Apiworking.</Alert>}
      {st.configured && st.read && readOnly && <Alert tone="info" title="Modo de solo lectura">El envío de ventas a Apiworking está desactivado en esta instalación.</Alert>}

      {billing.data && (
        <Alert tone="info" title={`Cobro de ${billing.data.patient.name}`}>
          {billing.data.appointment ? 'Cita atendida. ' : ''}
          {billing.data.customer ? `Cliente en Apiworking: ${billing.data.customer.name}.` : billing.data.identifier ? `${billing.data.identifier.docTypeLabel} ${billing.data.identifier.docNumber}: todavía no es cliente en Apiworking; créelo abajo con «Crear cliente por documento».` : 'El paciente no tiene documento registrado: elija o cree un cliente manualmente.'}
          {billing.data.alreadyBilled && ` Esta cita ya tiene una venta (${billing.data.alreadyBilled.docStatusLabel}).`}
        </Alert>
      )}
      {canSell && !pendingSale && (
        <form className="chip-row" style={{ alignItems: 'flex-end', marginBottom: 'var(--space-4)' }} onSubmit={(e) => { e.preventDefault(); const v = dni.trim(); if (v.length >= 6) { prefilled.current = null; setParams({ dni: v }, { replace: true }); } }}>
          <div style={{ minWidth: 260 }}><TextField label="Cobrar a un paciente por DNI" help="Trae lo que le hizo el odontólogo, su receta y el cliente." inputMode="numeric" autoComplete="off" value={dni} onChange={(e) => setDni(e.target.value.replace(/[^0-9A-Za-z]/g, '').slice(0, 15))} /></div>
          <Button type="submit" icon={<Search size={16} aria-hidden="true" />} disabled={dni.trim().length < 6}>Buscar cuenta</Button>
        </form>
      )}
      {billing.data?.account && billing.data.account.items.length > 0 && !pendingSale && (
        <Alert tone="success" title={`Cuenta pendiente: ${fmtMoney(billing.data.account.totalCents)}`}>
          {billing.data.account.items.map((it) => `${it.name} × ${it.quantity}`).join(' · ')}. Ya está en el detalle de venta.
        </Alert>
      )}
      {billing.data?.account && billing.data.account.items.length === 0 && urlDocument && <Alert tone="info">{billing.data.patient.name} no tiene servicios pendientes de pago.</Alert>}
      {billing.error != null && <ErrorState error={billing.error} onRetry={billing.reload} />}
      {pendingSale && (
        <Alert tone="warning" title="Emitiendo una venta cobrada en contingencia">
          El dinero ya entró en la caja local: el cliente y el monto no se pueden cambiar. Elija el tipo de documento y la forma de pago y confirme la fecha del documento.
          <div style={{ marginTop: 'var(--space-3)', maxWidth: 220 }}><TextField label="Fecha del documento" type="date" value={docDate} onChange={(e) => setDocDate(e.target.value)} /></div>
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
                  <Button size="sm" variant="tertiary" onClick={() => setCustomer(null)}>Cambiar</Button>
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
                  <NewCustomer key={billing.data?.identifier?.docNumber ?? 'manual'} write={st.write} initial={billing.data && !billing.data.customer && billing.data.identifier ? { docType: billing.data.identifier.docType, docNumber: billing.data.identifier.docNumber, name: billing.data.patient.name } : undefined} onCreated={(cu) => { setCustomer(cu); found.reload(); }} />
                </>
              )}
            </section>

            {!contingency && (
              <section className="card" aria-labelledby="doc-h">
                <div className="card-head"><h2 id="doc-h" className="h3">Comprobante</h2></div>
                {c && c.cajas.length === 0 && <Alert tone="warning">Su usuario de Apiworking no tiene una caja asignada.</Alert>}
                {idCaja && c?.opened === false && <Alert tone="danger">Su caja no tiene una apertura vigente en Apiworking. Ábrala en «Caja chica» antes de vender.</Alert>}
                <div className="row-2">
                  {idCaja && c?.documentTypes && (
                    <SelectField label="Tipo de documento" value={idTipoDocumento} onChange={(e) => { setIdTipoDocumento(e.target.value); setIdSerie(''); setIdMetodoPago(''); }}>
                      <option value="">Elija el tipo</option>
                      {c.documentTypes.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                    </SelectField>
                  )}
                  {idTipoDocumento && c?.series && c.series.length > 1 && (
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
                <div key={i} className={`chip-row${l.serviceIds ? ' sale-line-account' : ''}`} style={{ alignItems: 'flex-end', marginBottom: 'var(--space-3)', ...(l.serviceIds ? { background: 'var(--accent-soft, #e6f4f1)', borderRadius: 8, padding: 'var(--space-2)' } : {}) }}>
                  <TextField label={`Concepto ${i + 1}`} help={l.serviceIds ? 'Realizado por el odontólogo' : undefined} value={l.name} onChange={(e) => setLines((all) => all.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} maxLength={120} />
                  <TextField label="Cantidad" inputMode="numeric" value={l.quantity} onChange={(e) => setLines((all) => all.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} style={{ width: '6rem' }} />
                  <TextField label="Precio unitario (S/)" help="IGV incluido" inputMode="decimal" value={l.price} onChange={(e) => setLines((all) => all.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))} style={{ width: '9rem' }} />
                  <span className="caption tabular" style={{ minWidth: '7rem', paddingBottom: 'var(--space-2)' }} aria-label={`Subtotal del concepto ${i + 1}`}>
                    {parsed[i] && parsed[i]!.cents !== null && Number.isInteger(parsed[i]!.quantity) ? `${parsed[i]!.quantity} × ${fmtMoney(parsed[i]!.cents!)} = ${fmtMoney(parsed[i]!.cents! * parsed[i]!.quantity)}` : ''}
                  </span>
                  {lines.length > 1 && <Button size="sm" variant="tertiary" aria-label={`Quitar el concepto ${i + 1}`} icon={<Trash2 size={16} aria-hidden="true" />} onClick={() => setLines((all) => all.filter((_, j) => j !== i))} />}
                </div>
              ))}
              <div className="chip-row" style={{ alignItems: 'flex-end' }}>
                <Button size="sm" icon={<Plus size={16} aria-hidden="true" />} onClick={() => setLines((all) => [...all, emptyLine()])} disabled={lines.length >= 30}>Agregar concepto</Button>
              </div>
              {catalog.data && catalog.data.length > 0 && <CatalogSearch products={catalog.data} inSale={(n) => lines.some((l) => l.name.trim() === n)} onAdd={(p) => addLine(p.name, p.priceCents)} />}
            </section>

            {billing.data?.prescriptions && billing.data.prescriptions.length > 0 && !pendingSale && (
              <PrescriptionsCard
                prescriptions={billing.data.prescriptions}
                inSale={(name) => lines.some((l) => l.name.trim() === name)}
                onAdd={addLine}
              />
            )}
          </div>

          <aside className="card sale-side" aria-labelledby="sum-h">
            <h2 id="sum-h" className="h3">Resumen de venta</h2>
            {!contingency && !pendingSale && (
              <div style={{ marginTop: 'var(--space-4)' }}>
                <p className="caption muted tabular" style={{ margin: 0 }}>Subtotal {fmtMoney(total)}</p>
                <TextField label="Descuento (S/)" optional inputMode="decimal" autoComplete="off" value={discount} onChange={(e) => setDiscount(e.target.value)} error={discount.trim() && !discountOk ? 'El descuento debe ser menor que el total.' : null} />
              </div>
            )}
            <p className="muted" style={{ margin: 'var(--space-4) 0 0' }}>{discountCents ? 'Total a cobrar' : 'Importe total'}</p>
            <p className="money sale-total">{fmtMoney(discountOk ? net : total)}</p>
            <p className="caption muted">IGV incluido{discountCents && discountOk ? ` · descuento ${fmtMoney(discountCents)}` : ''}</p>
            {!contingency && idTipoDocumento && c?.paymentMethods && !split && (
              <fieldset className="pay-options">
                <legend className="h3">Forma de pago</legend>
                {c.paymentMethods.map((m) => (
                  <button key={m.id} type="button" className="pay-option" aria-pressed={idMetodoPago === m.id} onClick={() => setIdMetodoPago(m.id)}>
                    <PayIcon name={m.name} /> <span>{m.name}</span>
                  </button>
                ))}
                {c.paymentMethods.length > 1 && !pendingSale && (
                  <Button size="sm" variant="tertiary" onClick={() => setSplit([{ id: idMetodoPago || c.paymentMethods![0]!.id, amount: '' }, { id: c.paymentMethods!.find((m) => m.id !== (idMetodoPago || c.paymentMethods![0]!.id))!.id, amount: '' }])}>Pagar con varios medios</Button>
                )}
              </fieldset>
            )}
            {!contingency && c?.paymentMethods && split && (
              <fieldset className="pay-options" aria-label="Pago con varios medios">
                <legend className="h3">Pago con varios medios</legend>
                {split.map((p, i) => (
                  <div key={i} className="chip-row" style={{ alignItems: 'flex-end' }}>
                    <SelectField label={`Medio ${i + 1}`} value={p.id} onChange={(e) => setSplit((all) => all!.map((x, j) => (j === i ? { ...x, id: e.target.value } : x)))}>
                      {c.paymentMethods!.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                    </SelectField>
                    <TextField label="Monto (S/)" inputMode="decimal" autoComplete="off" value={p.amount} onChange={(e) => setSplit((all) => all!.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} style={{ width: '7rem' }} />
                    {split.length > 2 && <Button size="sm" variant="tertiary" aria-label={`Quitar el medio ${i + 1}`} icon={<Trash2 size={16} aria-hidden="true" />} onClick={() => setSplit((all) => all!.filter((_, j) => j !== i))} />}
                  </div>
                ))}
                <p className={`caption tabular${splitSum === net ? '' : ' muted'}`} role="status">
                  {splitSum === net ? 'Los montos cuadran con el total.' : splitSum < net ? `Falta asignar ${fmtMoney(net - splitSum)}.` : `Sobran ${fmtMoney(splitSum - net)}.`}
                </p>
                {new Set(split.map((p) => p.id)).size !== split.length && <p className="field-error" role="alert">Use cada medio una sola vez.</p>}
                <div className="chip-row">
                  {split.length < 4 && split.length < c.paymentMethods.length && <Button size="sm" icon={<Plus size={16} aria-hidden="true" />} onClick={() => setSplit((all) => [...all!, { id: c.paymentMethods!.find((m) => !all!.some((x) => x.id === m.id))!.id, amount: '' }])}>Agregar medio</Button>}
                  <Button size="sm" variant="tertiary" onClick={() => setSplit(null)}>Un solo medio</Button>
                </div>
              </fieldset>
            )}
            {contingency && customer && (
              <ContingencyBlock customer={customer} description={description} lines={parsed} validLines={validLines && description.length >= 3} link={link} docDate={docDate} serviceIds={accountIds} onDone={() => { reset(); sales.reload(); if (fromUrl) setParams({}, { replace: true }); }} />
            )}
            {!contingency && (
              <>
                {error && <Alert tone="danger">{error}</Alert>}
                <Button variant="primary" disabled={!draft || readOnly || c?.opened === false} loading={busy} loadingText="Registrando venta…" onClick={() => void sell()}>Cobrar {fmtMoney(discountOk ? net : total)}</Button>
                <Button variant="tertiary" onClick={reset}>Limpiar venta</Button>
              </>
            )}
          </aside>
        </div>

        </>
      )}

      <section aria-labelledby="sales-h" style={{ marginTop: 'var(--space-8)' }}>
        <div className="page-head"><h2 id="sales-h" className="h2">Ventas registradas</h2><Button size="sm" icon={<RefreshCw size={16} aria-hidden="true" />} onClick={sales.reload}>Actualizar</Button></div>
        {sales.loading && !sales.data && <Loading rows={3} />}
        {sales.error != null && <ErrorState error={sales.error} onRetry={sales.reload} />}
        {sales.data?.items.length === 0 && <EmptyState title="Todavía no hay ventas">Las ventas que envíe a Apiworking aparecerán aquí.</EmptyState>}
        {sales.data && sales.data.items.length > 0 && (
          <div className="table-wrap table-cards">
            <table>
              <caption className="sr-only">Ventas registradas en Apiworking</caption>
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
                      {s.failureReason && (s.docStatus === 'REJECTED' || s.docStatus === 'SENT' || s.docStatus === 'PENDING_ISSUE') && <p className="caption muted">{s.failureReason}</p>}
                    </td>
                    <td data-label="Cobro"><Badge tone={PAY_TONE[s.paymentStatus]}>{s.paymentStatusLabel}</Badge></td>
                    <td data-label="Acciones">
                      <div className="chip-row">
                        {s.actions.issue && canSell && !readOnly && <Button size="sm" variant="primary" onClick={() => startIssue(s)}>Emitir en Apiworking</Button>}
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

      {voidOf && (
        <ReasonDialog
          title="Anular venta en Apiworking" danger confirmLabel="Anular venta" example="Error en el monto"
          explain={`Se pedirá a Apiworking anular ${voidOf.externalNumber ?? 'este documento'} por ${voidOf.totalText}. Después se verifica el resultado.`}
          onClose={() => setVoidOf(null)}
          onConfirm={async (reason) => { await post(`/apiworking/sales/${voidOf.id}/void`, { reason }); setVoidOf(null); sales.reload(); toast.success('Anulación enviada a Apiworking.'); }}
        />
      )}
    </>
  );
}

/** Buscador del catálogo (productos y servicios): escribir para filtrar y «Agregar» suma el concepto con su precio. */
function CatalogSearch({ products, inSale, onAdd }: { products: Product[]; inSale: (name: string) => boolean; onAdd: (p: Product) => void }) {
  const [q, setQ] = useState('');
  const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const term = norm(q.trim());
  const found = term.length < 2 ? [] : products.filter((p) => norm(p.name).includes(term)).slice(0, 8);
  return (
    <div style={{ marginTop: 'var(--space-4)' }}>
      <TextField label="Buscar producto o servicio" help="Por ejemplo, lo que recetó el odontólogo." autoComplete="off" value={q} onChange={(e) => setQ(e.target.value)} />
      {term.length >= 2 && found.length === 0 && <p className="caption muted">No hay productos que coincidan en el catálogo.</p>}
      {found.length > 0 && (
        <ul className="context-list" aria-label="Resultados del catálogo">
          {found.map((p) => (
            <li key={p.id} className="chip-row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <span><strong>{p.name}</strong>{p.presentation ? <span className="caption muted"> · {p.presentation}</span> : null} · {fmtMoney(p.priceCents)}{p.kind === 'SERVICE' ? <span className="caption muted"> · servicio</span> : null}</span>
              <Button size="sm" variant="secondary" disabled={inSale(p.name)} aria-label={inSale(p.name) ? `${p.name} ya está en la venta` : `Agregar ${p.name} a la venta`} onClick={() => onAdd(p)}>{inSale(p.name) ? 'En la venta' : 'Agregar'}</Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Concepto de venta para un medicamento recetado: el nombre del catálogo si lo hay; si no, medicamento y dosis (máx. 120 caracteres). */
const rxLine = (i: AwBillingPrescription['items'][number]) => (i.product?.name ?? [i.medication, i.dose].filter(Boolean).join(' ')).slice(0, 120);

/** Receta del odontólogo en el cobro: se puede sumar cada medicamento a la venta (con su precio) o cobrar solo el servicio. */
function PrescriptionsCard({ prescriptions, inSale, onAdd }: { prescriptions: AwBillingPrescription[]; inSale: (name: string) => boolean; onAdd: (name: string, priceCents?: number | null) => void }) {
  const pending = prescriptions.flatMap((p) => p.items).filter((i) => !inSale(rxLine(i)));
  return (
    <section className="card" aria-labelledby="rx-h">
      <div className="card-head">
        <h2 id="rx-h" className="h3">Receta del odontólogo</h2>
        {pending.length > 1 && <Button size="sm" icon={<Plus size={16} aria-hidden="true" />} onClick={() => pending.forEach((i) => onAdd(rxLine(i), i.product?.priceCents))}>Agregar todo</Button>}
      </div>
      <p className="caption muted">Si el paciente lleva lo recetado, agréguelo a la venta: lo que está en el catálogo trae su precio; lo demás, escríbalo. Si no, cobre solo el servicio.</p>
      {prescriptions.map((p) => (
        <div key={p.id} style={{ marginTop: 'var(--space-3)' }}>
          <p className="caption"><strong className="tabular">{p.code}</strong>{p.prescriber ? ` · ${p.prescriber}` : ''}</p>
          <ul className="context-list">
            {p.items.map((i, k) => {
              const name = rxLine(i);
              const added = inSale(name);
              return (
                <li key={k} className="chip-row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                  <span><strong>{i.medication}</strong>{i.dose ? ` ${i.dose}` : ''}<span className="caption muted">{[i.frequency, i.duration].filter(Boolean).length ? ` · ${[i.frequency, i.duration].filter(Boolean).join(' · ')}` : ''}</span>{i.product ? <span className="caption"> · <strong>{fmtMoney(i.product.priceCents)}</strong></span> : <span className="caption muted"> · sin precio en el catálogo</span>}</span>
                  <Button size="sm" variant={added ? 'tertiary' : 'secondary'} disabled={added} onClick={() => onAdd(name, i.product?.priceCents)} aria-label={added ? `${i.medication} ya está en la venta` : `Agregar ${i.medication} a la venta`}>{added ? 'En la venta' : 'Agregar'}</Button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
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

/** Alta de cliente por documento (ClienteDoc) en un clic: si ya existe en Apiworking se usa; si no, se crea. */
function NewCustomer({ write, initial, onCreated }: { write: boolean; initial?: { docType: string; docNumber: string; name: string }; onCreated: (c: AwCustomer) => void }) {
  const toast = useToast();
  const [openForm, setOpenForm] = useState(Boolean(initial));
  const [docType, setDocType] = useState(initial?.docType ?? '1');
  const [docNumber, setDocNumber] = useState(initial?.docNumber ?? '');
  const [name] = useState(initial?.name ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const sending = useRef(false);

  const create = async () => {
    if (sending.current) return;
    sending.current = true; setBusy(true); setError(null); setNote(null);
    try {
      const body = { docType, docNumber: docNumber.trim() };
      const prev = await post<AwCustomerPreview>('/apiworking/clients/preview', body);
      if (prev.exists) {
        onCreated({ id: prev.exists.id, personId: '', name: prev.exists.name, email: '', docType: prev.docTypeLabel, docNumber: prev.docNumber, phone: '', whatsapp: '', personType: '', active: true });
        setOpenForm(false); setDocNumber('');
        return;
      }
      const r = await post<AwCustomerResult>('/apiworking/clients', { ...body, approvedHash: prev.hash, ...(name.trim() ? { name: name.trim() } : {}) });
      if (r.status === 'CREATED' && r.customer) { toast.success('Cliente creado en Apiworking'); onCreated(r.customer); setOpenForm(false); setDocNumber(''); }
      else setNote(r.status === 'CREATED' ? 'Cliente creado. Búsquelo en la lista para elegirlo.' : r.message ?? 'No se pudo confirmar el alta. Búsquelo en la lista.');
    } catch (e) { setError(errorText(e)); }
    finally { sending.current = false; setBusy(false); }
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
      {!write && <Alert tone="info">Las escrituras reales están desactivadas en esta instalación.</Alert>}
      <div className="chip-row">
        <Button variant="primary" disabled={docNumber.trim().length === 0 || !write} loading={busy} loadingText="Creando…" onClick={() => void create()}>Crear cliente</Button>
        <Button variant="tertiary" onClick={() => { setOpenForm(false); setError(null); }}>Cancelar</Button>
      </div>
    </div>
  );
}

/** Cobro en contingencia: se guarda la venta «por emitir» y el dinero entra en la caja LOCAL. No se llama a Apiworking. */
function ContingencyBlock({ customer, description, lines, validLines, link, docDate, serviceIds, onDone }: {
  customer: AwCustomer; description: string; lines: { name: string; quantity: number; cents: number | null }[]; validLines: boolean;
  link: { appointmentId?: string; patientId?: string }; docDate: string; serviceIds: string[]; onDone: () => void;
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
        ...(serviceIds.length ? { visitServiceIds: serviceIds } : {}),
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
