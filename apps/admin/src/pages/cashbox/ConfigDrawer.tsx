import { useState } from 'react';
import { Plus } from 'lucide-react';
import { post, put } from '../../api/client';
import type { CashConfig } from '../../api/types';
import { Button } from '../../ui/Button';
import { SelectField, TextField } from '../../ui/fields';
import { Badge, errorText, useToast } from '../../ui/feedback';
import { Drawer } from '../../ui/overlays';

const KINDS = [['CASH', 'Efectivo'], ['CARD', 'Tarjeta'], ['YAPE_PLIN', 'Yape / Plin'], ['TRANSFER', 'Transferencia'], ['OTHER', 'Otro']] as const;

/** Cuentas o medios de pago y tipos de operación. Se desactivan, nunca se borran (los movimientos pasados los conservan). */
export function ConfigDrawer({ config, onClose, onChanged }: { config: CashConfig; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [accName, setAccName] = useState('');
  const [accKind, setAccKind] = useState('OTHER');
  const [catName, setCatName] = useState('');
  const [catFlow, setCatFlow] = useState<'INCOME' | 'EXPENSE'>('INCOME');
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>, after?: () => void) => {
    setError(null);
    try { await fn(); after?.(); onChanged(); } catch (e) { setError(errorText(e)); toast.error(errorText(e)); }
  };
  const toggleAccount = (a: CashConfig['accounts'][number]) => run(() => put(`/cashbox/accounts/${a.id}`, { name: a.name, kind: a.kind, allowNegative: a.allowNegative, active: !a.active }));
  const toggleNegative = (a: CashConfig['accounts'][number]) => run(() => put(`/cashbox/accounts/${a.id}`, { name: a.name, kind: a.kind, allowNegative: !a.allowNegative, active: a.active }));
  const toggleCategory = (c: CashConfig['categories'][number]) => run(() => put(`/cashbox/categories/${c.id}`, { name: c.name, active: !c.active }));
  return (
    <Drawer title="Configurar caja chica" width={640} onClose={onClose} footer={<Button onClick={onClose}>Cerrar</Button>}>
      <div style={{ display: 'grid', gap: 'var(--space-7)' }}>
        {error && <p className="field-error" role="alert">{error}</p>}
        <section aria-labelledby="cfg-acc">
          <h3 id="cfg-acc" className="h3" style={{ marginBottom: 'var(--space-4)' }}>Cuentas o medios de pago</h3>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 'var(--space-3)' }}>
            {config.accounts.map((a) => (
              <li key={a.id} style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'space-between' }}>
                <span><strong>{a.name}</strong> <Badge tone="neutral">{a.kindLabel}</Badge> {!a.active && <Badge tone="warning">Inactiva</Badge>} {a.allowNegative && <Badge tone="info">Permite saldo negativo</Badge>}</span>
                <span className="chip-row">
                  <Button size="sm" aria-label={`${a.allowNegative ? 'No permitir' : 'Permitir'} saldo negativo en ${a.name}`} onClick={() => void toggleNegative(a)}>{a.allowNegative ? 'No permitir negativo' : 'Permitir negativo'}</Button>
                  <Button size="sm" variant="tertiary" aria-label={`${a.active ? 'Desactivar' : 'Activar'} la cuenta ${a.name}`} onClick={() => void toggleAccount(a)}>{a.active ? 'Desactivar' : 'Activar'}</Button>
                </span>
              </li>
            ))}
          </ul>
          <form onSubmit={(e) => { e.preventDefault(); void run(() => post('/cashbox/accounts', { name: accName, kind: accKind }), () => setAccName('')); }} className="toolbar" style={{ marginTop: 'var(--space-4)' }}>
            <TextField label="Nueva cuenta" value={accName} maxLength={80} onChange={(e) => setAccName(e.target.value)} placeholder="Ejemplo: Cuenta BCP" />
            <SelectField label="Tipo" value={accKind} onChange={(e) => setAccKind(e.target.value)}>{KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</SelectField>
            <Button type="submit" icon={<Plus size={16} aria-hidden="true" />} disabled={accName.trim().length < 2}>Agregar cuenta</Button>
          </form>
        </section>
        <section aria-labelledby="cfg-cat">
          <h3 id="cfg-cat" className="h3" style={{ marginBottom: 'var(--space-4)' }}>Tipos de operación</h3>
          {(['INCOME', 'EXPENSE'] as const).map((flow) => (
            <div key={flow} style={{ marginBottom: 'var(--space-4)' }}>
              <h4 className="h4">{flow === 'INCOME' ? 'Ingresos' : 'Egresos'}</h4>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 'var(--space-2)' }}>
                {config.categories.filter((c) => c.flow === flow).map((c) => (
                  <li key={c.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--space-3)' }}>
                    <span>{c.name} {!c.active && <Badge tone="warning">Inactivo</Badge>}</span>
                    <Button size="sm" variant="tertiary" aria-label={`${c.active ? 'Desactivar' : 'Activar'} ${c.name}`} onClick={() => void toggleCategory(c)}>{c.active ? 'Desactivar' : 'Activar'}</Button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <form onSubmit={(e) => { e.preventDefault(); void run(() => post('/cashbox/categories', { name: catName, flow: catFlow }), () => setCatName('')); }} className="toolbar">
            <TextField label="Nuevo tipo de operación" value={catName} maxLength={80} onChange={(e) => setCatName(e.target.value)} />
            <SelectField label="Aplica a" value={catFlow} onChange={(e) => setCatFlow(e.target.value as 'INCOME' | 'EXPENSE')}><option value="INCOME">Ingresos</option><option value="EXPENSE">Egresos</option></SelectField>
            <Button type="submit" icon={<Plus size={16} aria-hidden="true" />} disabled={catName.trim().length < 2}>Agregar tipo</Button>
          </form>
        </section>
      </div>
    </Drawer>
  );
}
