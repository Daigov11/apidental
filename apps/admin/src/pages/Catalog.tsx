import { useState } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import { get, patch, post } from '../api/client';
import type { Product } from '../api/types';
import { fmtMoney, parseSoles } from '../lib/money';
import { useAsync } from '../lib/useAsync';
import { Button } from '../ui/Button';
import { SelectField, TextField } from '../ui/fields';
import { Alert, Badge, EmptyState, ErrorState, Loading, errorText, useToast } from '../ui/feedback';
import { Dialog } from '../ui/overlays';

/** Catálogo de productos y medicamentos con su precio de venta. El nombre debe coincidir con el de la receta para que el precio salga solo en caja. */
export function CatalogPage() {
  const toast = useToast();
  const list = useAsync(() => get<Product[]>('/products', { all: '1' }), []);
  const [editing, setEditing] = useState<Product | 'new' | null>(null);
  const [filter, setFilter] = useState('');
  const [kind, setKind] = useState<'' | 'PRODUCT' | 'SERVICE'>('');
  const shown = (list.data ?? []).filter((p) => p.name.toLowerCase().includes(filter.trim().toLowerCase()) && (!kind || (p.kind ?? 'PRODUCT') === kind));

  const toggle = async (p: Product) => {
    try { await patch(`/products/${p.id}`, { active: !p.active }); toast.success(p.active ? `«${p.name}» ya no se ofrece en caja.` : `«${p.name}» vuelve a ofrecerse en caja.`); }
    catch (e) { toast.error(errorText(e)); }
    finally { list.reload(); }
  };

  return (
    <>
      <div className="page-head">
        <div><h1>Catálogo</h1><p className="muted">Servicios (lo que hace el odontólogo, con su precio por pieza o por vez) y productos o medicamentos que se venden en caja. Precios con IGV.</p></div>
        <div className="chip-row">
          <Button size="sm" icon={<RefreshCw size={16} aria-hidden="true" />} onClick={list.reload}>Actualizar</Button>
          <Button variant="primary" icon={<Plus size={18} aria-hidden="true" />} onClick={() => setEditing('new')}>Nuevo producto o servicio</Button>
        </div>
      </div>
      <Alert tone="info">Escriba el nombre tal como lo receta el odontólogo (por ejemplo «Amoxicilina 500 mg»): al cobrar la cita, el medicamento recetado toma este precio. En la receta, el campo «Medicamento» sugiere estos nombres.</Alert>
      <div className="row-2" style={{ maxWidth: 620, marginTop: 'var(--space-4)' }}>
        <TextField label="Buscar" value={filter} autoComplete="off" onChange={(e) => setFilter(e.target.value)} />
        <SelectField label="Tipo" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          <option value="">Todos</option><option value="SERVICE">Servicios</option><option value="PRODUCT">Productos</option>
        </SelectField>
      </div>
      {list.loading && !list.data && <Loading rows={4} />}
      {list.error != null && <ErrorState error={list.error} onRetry={list.reload} />}
      {list.data?.length === 0 && <EmptyState title="El catálogo está vacío">Agregue los medicamentos y productos que se venden en la clínica.</EmptyState>}
      {shown.length > 0 && (
        <div className="table-wrap table-cards" style={{ marginTop: 'var(--space-4)' }}>
          <table>
            <caption className="sr-only">Productos del catálogo</caption>
            <thead><tr><th scope="col">Nombre</th><th scope="col">Tipo</th><th scope="col">Presentación</th><th scope="col" className="num">Precio</th><th scope="col">Estado</th><th scope="col">Acciones</th></tr></thead>
            <tbody>
              {shown.map((p) => (
                <tr key={p.id}>
                  <td data-label="Nombre">{p.name}</td>
                  <td data-label="Tipo"><Badge tone={p.kind === 'SERVICE' ? 'info' : 'neutral'}>{p.kind === 'SERVICE' ? 'Servicio' : 'Producto'}</Badge></td>
                  <td data-label="Presentación">{p.presentation ?? '—'}</td>
                  <td data-label="Precio" className="num">{fmtMoney(p.priceCents)}</td>
                  <td data-label="Estado"><Badge tone={p.active ? 'success' : 'neutral'}>{p.active ? 'Activo' : 'Inactivo'}</Badge></td>
                  <td data-label="Acciones">
                    <div className="chip-row">
                      <Button size="sm" onClick={() => setEditing(p)}>Editar</Button>
                      <Button size="sm" variant="tertiary" onClick={() => void toggle(p)}>{p.active ? 'Desactivar' : 'Activar'}</Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <ProductDialog
          product={editing === 'new' ? null : editing} onClose={() => setEditing(null)}
          onSaved={(p, created) => { setEditing(null); list.reload(); toast.success(created ? `«${p.name}» agregado al catálogo.` : 'Producto actualizado.'); }}
        />
      )}
    </>
  );
}

function ProductDialog({ product, onClose, onSaved }: { product: Product | null; onClose: () => void; onSaved: (p: Product, created: boolean) => void }) {
  const [name, setName] = useState(product?.name ?? '');
  const [presentation, setPresentation] = useState(product?.presentation ?? '');
  const [price, setPrice] = useState(product ? (product.priceCents / 100).toFixed(2) : '');
  const [kind, setKind] = useState<'PRODUCT' | 'SERVICE'>(product?.kind ?? 'SERVICE');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cents = parseSoles(price);
  const invalid = name.trim().length < 2 || cents === null || cents < 1;
  const submit = async () => {
    if (invalid || busy) return;
    setBusy(true); setError(null);
    const body = { name: name.trim(), presentation: presentation.trim(), priceCents: cents, kind };
    try {
      const saved = product ? await patch<Product>(`/products/${product.id}`, body) : await post<Product>('/products', body);
      onSaved(saved, !product);
    } catch (e) { setError(errorText(e)); setBusy(false); }
  };
  return (
    <Dialog title={product ? 'Editar' : 'Nuevo producto o servicio'} onClose={onClose} footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" disabled={invalid} loading={busy} loadingText="Guardando…" onClick={() => void submit()}>Guardar</Button></>}>
      {error && <Alert tone="danger">{error}</Alert>}
      <SelectField label="Tipo" value={kind} onChange={(e) => setKind(e.target.value as 'PRODUCT' | 'SERVICE')}>
        <option value="SERVICE">Servicio (lo realiza el odontólogo: curación, endodoncia…)</option>
        <option value="PRODUCT">Producto o medicamento (se vende en caja)</option>
      </SelectField>
      <TextField label="Nombre" help={kind === 'SERVICE' ? 'Por ejemplo «Curación de caries» o «Endodoncia».' : 'Como se escribe en la receta, por ejemplo «Amoxicilina 500 mg».'} value={name} maxLength={120} autoComplete="off" onChange={(e) => setName(e.target.value)} />
      <TextField label="Presentación" optional help="Por ejemplo «caja x 21 cápsulas»." value={presentation} maxLength={80} autoComplete="off" onChange={(e) => setPresentation(e.target.value)} />
      <TextField label={kind === 'SERVICE' ? 'Precio por pieza o por vez (S/)' : 'Precio de venta (S/)'} help="IGV incluido." inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
    </Dialog>
  );
}
