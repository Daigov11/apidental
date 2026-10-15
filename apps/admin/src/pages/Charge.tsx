import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Download, FileText, RefreshCw, RotateCcw } from 'lucide-react';
import { ApiError, get, post } from '../api/client';
import type { Charge } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { downloadFile } from '../lib/download';
import { fmtDateTime } from '../lib/format';
import { useIntegrations } from '../lib/integrations';
import { useAsync } from '../lib/useAsync';
import { Button } from '../ui/Button';
import { SelectField, TextField } from '../ui/fields';
import { Alert, Badge, DocStatusBadge, ErrorState, Loading, SimulatedTag, errorText, useToast } from '../ui/feedback';
import { ReasonDialog } from '../ui/overlays';

const CODE_TEXT: Record<string, string> = {
  VERSION_CONFLICT: 'El cobro cambió mientras lo editaba. Se recargó; revise e intente de nuevo.',
  INVALID_TRANSITION: 'El cobro o comprobante ya no admite este cambio.',
  DOCUMENT_EXISTS: 'Este cobro ya tiene un comprobante vigente.',
  CHARGE_NOT_PAID: 'Primero registre el pago.',
};
const explain = (e: unknown) => (e instanceof ApiError && e.code && CODE_TEXT[e.code]) || errorText(e);

export function ChargePage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const toast = useToast();
  const { scenarios } = useIntegrations();
  const charge = useAsync(() => get<Charge>(`/billing/charges/${id}`), [id]);
  const [method, setMethod] = useState('CASH');
  const [type, setType] = useState<'BOLETA' | 'FACTURA'>('BOLETA');
  const [ruc, setRuc] = useState('');
  const [name, setName] = useState('');
  const [scenario, setScenario] = useState('ISSUE');
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [voiding, setVoiding] = useState(false);
  const c = charge.data;

  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try { await fn(); toast.success(ok); } catch (e) { toast.error(explain(e)); }
    finally { setBusy(null); charge.reload(); }
  };

  if (charge.loading && !c) return <Loading rows={4} />;
  if (charge.error != null) return <ErrorState error={charge.error} onRetry={charge.reload} />;
  if (!c) return null;
  const doc = c.document;
  const facturaMissing = type === 'FACTURA' && (!/^\d{11}$/.test(ruc) || name.trim().length < 3);

  const emit = (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (facturaMissing) return;
    void run('emit', () => post(`/billing/charges/${id}/document`, { type, scenario, ...(type === 'FACTURA' ? { customerRuc: ruc, customerName: name.trim() } : {}) }), 'Comprobante enviado a la cola (simulación).');
  };

  return (
    <>
      <p><Link to="/caja">‹ Caja</Link></p>
      <div className="page-head">
        <div><h1>Cobro</h1><p className="muted">{c.patient.name} · {fmtDateTime(c.createdAt)}</p></div>
        <SimulatedTag />
      </div>

      <section className="card" aria-labelledby="charge-h">
        <div className="card-head"><h2 id="charge-h" className="h3">{c.description}</h2><Badge tone={c.status === 'PAID' ? 'success' : c.status === 'VOIDED' ? 'neutral' : 'warning'}>{c.statusLabel}</Badge></div>
        <p className="money">{c.amountText}</p>
        {c.paidAt && <p className="muted">Pagado el {fmtDateTime(c.paidAt)} · {c.paymentMethodLabel}</p>}
        {c.actions.pay && can('charge:manage') && (
          <form onSubmit={(e) => { e.preventDefault(); void run('pay', () => post(`/billing/charges/${id}/pay`, { method, expectedVersion: c.version }), 'Pago registrado.'); }} style={{ marginTop: 'var(--space-6)', maxWidth: 360 }}>
            <SelectField label="Medio de pago" value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="CASH">Efectivo</option><option value="CARD">Tarjeta</option><option value="YAPE_PLIN">Yape / Plin</option><option value="TRANSFER">Transferencia</option>
            </SelectField>
            <div className="chip-row">
              <Button type="submit" variant="primary" loading={busy === 'pay'} loadingText="Registrando…">Registrar pago</Button>
              {c.actions.void && <Button variant="danger" onClick={() => setVoiding(true)}>Anular cobro</Button>}
            </div>
          </form>
        )}
        {c.status === 'PAID' && <Alert tone="info">Al pagar se encolaron los puntos de fidelización y la solicitud de reseña (simulación). Se procesan desde «Comprobantes → Procesar cola».</Alert>}
      </section>

      {c.status === 'PAID' && (
        <section className="card" aria-labelledby="doc-h">
          <div className="card-head"><h2 id="doc-h" className="h3">Comprobante</h2><SimulatedTag /></div>
          {doc && (
            <div className="doc-card card" style={{ marginBottom: 'var(--space-5)' }}>
              <p className="demo-mark" role="note">{doc.demoMark}</p>
              <h3 className="h3" style={{ margin: 'var(--space-4) 0' }}>{doc.typeLabel} · <span className="tabular">{doc.number}</span></h3>
              <p><DocStatusBadge status={doc.status} label={doc.statusLabel} /></p>
              <dl className="facts" style={{ marginTop: 'var(--space-4)' }}>
                <dt>Cliente</dt><dd>{doc.customer.name}</dd>
                <dt>Documento</dt><dd className="tabular">{doc.customer.docType} {doc.customer.docNumber}</dd>
                <dt>Subtotal</dt><dd className="tabular">{doc.subtotalText}</dd>
                <dt>IGV (18 %)</dt><dd className="tabular">{doc.igvText}</dd>
                <dt>Total</dt><dd className="tabular">{doc.amountText}</dd>
                {doc.scenarioLabel && <><dt>Escenario simulado</dt><dd>{doc.scenarioLabel}</dd></>}
                {doc.providerRef && <><dt>Referencia del simulador</dt><dd className="tabular">{doc.providerRef}</dd></>}
                {doc.rejectionReason && <><dt>Motivo del rechazo</dt><dd>{doc.rejectionReason}</dd></>}
                <dt>Intentos</dt><dd>{doc.attempts}</dd>
              </dl>
              {doc.status === 'NEEDS_RECONCILIATION' && <Alert tone="warning" title="No sabemos si el proveedor lo procesó">Concilie para consultar al proveedor. No se reenvía a ciegas: la misma clave evita duplicados.</Alert>}
              {doc.status === 'SENT' && <Alert tone="info" title="Enviado, falta la confirmación">Concilie para consultar su estado.</Alert>}
              <div className="chip-row" style={{ marginTop: 'var(--space-5)' }}>
                {doc.actions.retry && can('billing:manage') && <Button icon={<RotateCcw size={18} aria-hidden="true" />} loading={busy === 'retry'} loadingText="Reintentando…" onClick={() => void run('retry', () => post(`/billing/documents/${doc.id}/retry`), 'Reintento realizado.')}>Reintentar</Button>}
                {doc.actions.reconcile && can('billing:manage') && <Button icon={<RefreshCw size={18} aria-hidden="true" />} loading={busy === 'reconcile'} loadingText="Conciliando…" onClick={() => void run('reconcile', () => post(`/billing/documents/${doc.id}/reconcile`), 'Conciliación realizada.')}>Conciliar</Button>}
                <Button icon={<Download size={18} aria-hidden="true" />} loading={busy === 'pdf'} loadingText="Preparando…" onClick={() => void run('pdf', () => downloadFile(`/billing/documents/${doc.id}/pdf`, {}, `comprobante-demo-${doc.number}.pdf`), 'PDF descargado.')}>Descargar PDF</Button>
              </div>
            </div>
          )}
          {c.actions.emitDocument && can('billing:manage') && (
            <form onSubmit={emit} noValidate style={{ maxWidth: 480 }}>
              {doc?.status === 'REJECTED' && <Alert tone="warning">El comprobante anterior fue rechazado. Puede emitir uno nuevo; tendrá otro número.</Alert>}
              <SelectField label="Tipo de comprobante" value={type} onChange={(e) => setType(e.target.value as 'BOLETA' | 'FACTURA')}>
                <option value="BOLETA">Boleta de venta (simulada)</option><option value="FACTURA">Factura (simulada)</option>
              </SelectField>
              {type === 'FACTURA' && (
                <>
                  <TextField label="RUC del cliente (ficticio)" inputMode="numeric" maxLength={11} value={ruc} onChange={(e) => setRuc(e.target.value.replace(/\D/g, ''))} error={submitted && !/^\d{11}$/.test(ruc) ? 'El RUC debe tener 11 dígitos.' : null} />
                  <TextField label="Razón social (ficticia)" value={name} onChange={(e) => setName(e.target.value)} error={submitted && name.trim().length < 3 ? 'Escriba la razón social.' : null} />
                </>
              )}
              <SelectField label="Escenario de simulación" help="Solo para la demostración: elige qué responderá el simulador." value={scenario} onChange={(e) => setScenario(e.target.value)}>
                {scenarios.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
              </SelectField>
              <Button type="submit" variant="primary" icon={<FileText size={18} aria-hidden="true" />} loading={busy === 'emit'} loadingText="Emitiendo…">Emitir comprobante simulado</Button>
            </form>
          )}
          {!doc && !can('billing:manage') && <p className="muted">Aún no se emitió el comprobante.</p>}
        </section>
      )}

      {voiding && (
        <ReasonDialog title="Anular el cobro" explain="El cobro quedará anulado y la cita podrá cobrarse de nuevo. El registro se conserva." confirmLabel="Anular cobro" danger onClose={() => setVoiding(false)}
          onConfirm={async (reason) => { await post(`/billing/charges/${id}/void`, { reason, expectedVersion: c.version }); setVoiding(false); toast.success('Cobro anulado.'); charge.reload(); }} />
      )}
    </>
  );
}
