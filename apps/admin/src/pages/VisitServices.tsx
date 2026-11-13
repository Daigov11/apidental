import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { get, post } from '../api/client';
import type { Product } from '../api/types';
import { fmtMoney } from '../lib/money';
import { useAsync } from '../lib/useAsync';
import { Button } from '../ui/Button';
import { SelectField, TextField } from '../ui/fields';
import { Alert, EmptyState, ErrorState, Loading, errorText, useToast } from '../ui/feedback';
import { Dialog } from '../ui/overlays';

export interface VisitServiceItem { id: string; productId: string; name: string; unitPriceCents: number; teeth: string[]; quantity: number; subtotalCents: number; billed: boolean }

/** Arcadas en numeración FDI, como se ven de frente: superior derecha → izquierda, inferior derecha → izquierda. */
const ADULT = [
  ['18', '17', '16', '15', '14', '13', '12', '11', '21', '22', '23', '24', '25', '26', '27', '28'],
  ['48', '47', '46', '45', '44', '43', '42', '41', '31', '32', '33', '34', '35', '36', '37', '38'],
];
const CHILD = [
  ['55', '54', '53', '52', '51', '61', '62', '63', '64', '65'],
  ['85', '84', '83', '82', '81', '71', '72', '73', '74', '75'],
];

/** Selector de piezas: un toque marca o desmarca cada diente. */
export function ToothPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [child, setChild] = useState(false);
  const rows = child ? CHILD : ADULT;
  const toggle = (t: string) => onChange(value.includes(t) ? value.filter((x) => x !== t) : [...value, t].sort());
  return (
    <fieldset className="tooth-picker" style={{ border: 0, padding: 0 }}>
      <legend className="h4">Piezas tratadas</legend>
      <div className="chip-row" style={{ marginBottom: 'var(--space-2)' }}>
        <Button size="sm" variant={child ? 'tertiary' : 'secondary'} onClick={() => setChild(false)}>Permanentes</Button>
        <Button size="sm" variant={child ? 'secondary' : 'tertiary'} onClick={() => setChild(true)}>Temporales</Button>
      </div>
      {rows.map((row, i) => (
        <div key={i} className="tooth-row" role="group" aria-label={i === 0 ? 'Arcada superior' : 'Arcada inferior'} style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-1)', marginBottom: 'var(--space-2)' }}>
          {row.map((t) => (
            <button key={t} type="button" className="tooth" aria-pressed={value.includes(t)} aria-label={`Pieza ${t}`} onClick={() => toggle(t)}
              style={{ minWidth: 40, padding: '6px 4px', borderRadius: 8, border: '1px solid var(--border, #c7ced6)', fontVariantNumeric: 'tabular-nums', fontWeight: value.includes(t) ? 700 : 400, background: value.includes(t) ? 'var(--accent-soft, #d6eef1)' : 'transparent', cursor: 'pointer' }}>
              {t}
            </button>
          ))}
        </div>
      ))}
      <p className="caption muted">{value.length === 0 ? 'Si el servicio no es por pieza (por ejemplo, una limpieza), no marque ninguna.' : `${value.length} ${value.length === 1 ? 'pieza' : 'piezas'}: ${value.join(', ')}`}</p>
    </fieldset>
  );
}

/**
 * «Servicios realizados» de la atención: servicio del catálogo × piezas tratadas. Es la cuenta del paciente; al terminar la
 * consulta queda pendiente de pago en caja (se busca por DNI).
 */
export function VisitServicesCard({ patientId, visitId, editable }: { patientId: string; visitId: string; editable: boolean }) {
  const toast = useToast();
  const base = `/patients/${patientId}/clinical/visits/${visitId}/services`;
  const list = useAsync(() => get<{ items: VisitServiceItem[]; totalCents: number }>(base), [base]);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const remove = async (s: VisitServiceItem) => {
    setBusy(s.id);
    try { await post(`${base}/${s.id}/remove`); toast.success(`Se quitó «${s.name}».`); }
    catch (e) { toast.error(errorText(e)); }
    finally { setBusy(null); list.reload(); }
  };
  const items = list.data?.items ?? [];
  return (
    <section className="card" aria-labelledby="sv-h">
      <div className="card-head">
        <h2 id="sv-h" className="h3">Servicios realizados</h2>
        {editable && <Button size="sm" icon={<Plus size={16} aria-hidden="true" />} onClick={() => setAdding(true)}>Agregar servicio</Button>}
      </div>
      {list.loading && !list.data && <Loading rows={2} />}
      {list.error != null && <ErrorState error={list.error} onRetry={list.reload} />}
      {list.data && items.length === 0 && <EmptyState title="Sin servicios">Agregue lo que le hizo al paciente (por ejemplo, curación o endodoncia) y marque las piezas: es lo que pagará en caja.</EmptyState>}
      {items.length > 0 && (
        <div className="table-wrap table-cards">
          <table>
            <caption className="sr-only">Servicios realizados en la atención</caption>
            <thead><tr><th scope="col">Servicio</th><th scope="col">Piezas</th><th scope="col" className="num">Cant.</th><th scope="col" className="num">Precio</th><th scope="col" className="num">Subtotal</th>{editable && <th scope="col"><span className="sr-only">Acciones</span></th>}</tr></thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.id}>
                  <td data-label="Servicio">{s.name}</td>
                  <td data-label="Piezas" className="tabular">{s.teeth.length ? s.teeth.join(', ') : '—'}</td>
                  <td data-label="Cant." className="num">{s.quantity}</td>
                  <td data-label="Precio" className="num">{fmtMoney(s.unitPriceCents)}</td>
                  <td data-label="Subtotal" className="num">{fmtMoney(s.subtotalCents)}</td>
                  {editable && <td data-label="Acciones">{!s.billed && <Button size="sm" variant="tertiary" icon={<Trash2 size={16} aria-hidden="true" />} aria-label={`Quitar ${s.name}`} loading={busy === s.id} loadingText="Quitando…" onClick={() => void remove(s)}>Quitar</Button>}</td>}
                </tr>
              ))}
              <tr><td data-label="Servicio" colSpan={4}><strong>Total a pagar</strong></td><td data-label="Total" className="num"><strong>{fmtMoney(list.data!.totalCents)}</strong></td>{editable && <td />}</tr>
            </tbody>
          </table>
        </div>
      )}
      {adding && <AddServiceDialog base={base} onClose={() => setAdding(false)} onDone={(name) => { setAdding(false); list.reload(); toast.success(`«${name}» agregado.`); }} />}
    </section>
  );
}

function AddServiceDialog({ base, onClose, onDone }: { base: string; onClose: () => void; onDone: (name: string) => void }) {
  const services = useAsync(() => get<Product[]>('/products', { kind: 'SERVICE' }), []);
  const [productId, setProductId] = useState('');
  const [teeth, setTeeth] = useState<string[]>([]);
  const [quantity, setQuantity] = useState('1');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const svc = services.data?.find((p) => p.id === productId);
  const qty = teeth.length > 0 ? teeth.length : Number(quantity);
  const invalid = !svc || !Number.isInteger(qty) || qty < 1 || qty > 99;
  const submit = async () => {
    if (invalid || busy) return;
    setBusy(true); setError(null);
    try { await post(base, { productId, ...(teeth.length ? { teeth } : { quantity: qty }) }); onDone(svc!.name); }
    catch (e) { setError(errorText(e)); setBusy(false); }
  };
  return (
    <Dialog title="Agregar servicio" onClose={onClose} footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" disabled={invalid} loading={busy} loadingText="Agregando…" onClick={() => void submit()}>Agregar</Button></>}>
      {error && <Alert tone="danger">{error}</Alert>}
      {services.data?.length === 0 && <Alert tone="warning">No hay servicios en el catálogo. Pida al administrador que los cree en «Catálogo» (tipo Servicio, con su precio).</Alert>}
      <SelectField label="Servicio" value={productId} onChange={(e) => setProductId(e.target.value)}>
        <option value="">Elija el servicio</option>
        {services.data?.map((p) => <option key={p.id} value={p.id}>{p.name} · {fmtMoney(p.priceCents)}</option>)}
      </SelectField>
      <ToothPicker value={teeth} onChange={setTeeth} />
      {teeth.length === 0 && <TextField label="Cantidad" inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value.replace(/\D/g, ''))} style={{ width: '6rem' }} />}
      {svc && Number.isInteger(qty) && qty > 0 && <p><strong>{svc.name}</strong> × {qty} = <strong>{fmtMoney(svc.priceCents * qty)}</strong></p>}
    </Dialog>
  );
}
