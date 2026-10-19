import { useRef, useState, type FormEvent } from 'react';
import { post } from '../../api/client';
import type { CashConfig, CashMovement } from '../../api/types';
import { useAuth } from '../../auth/AuthProvider';
import { limaDate, timeOf } from '../../lib/format';
import { fmtMoney, parseSoles } from '../../lib/money';
import { Button } from '../../ui/Button';
import { SelectField, TextField } from '../../ui/fields';
import { errorText } from '../../ui/feedback';
import { Dialog } from '../../ui/overlays';

const nowField = () => `${limaDate()}T${timeOf(new Date().toISOString())}`;

/** Formulario único para ingresos y egresos. */
export function MovementDialog({ flow, config, balances, onClose, onSaved }: {
  flow: 'INCOME' | 'EXPENSE'; config: CashConfig; balances: Record<string, number>; onClose: () => void; onSaved: (m: CashMovement) => void;
}) {
  const { me } = useAuth();
  const income = flow === 'INCOME';
  const accounts = config.accounts.filter((a) => a.active);
  const categories = config.categories.filter((c) => c.active && c.flow === flow);
  const [description, setDescription] = useState('');
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '');
  const [categoryId, setCategoryId] = useState('');
  const [operationNumber, setOperationNumber] = useState('');
  const [amount, setAmount] = useState('');
  const [when, setWhen] = useState(nowField);
  const [whenTouched, setWhenTouched] = useState(false);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // La clave identifica este envío: un reintento (doble clic, red caída) no duplica el movimiento.
  const key = useRef(crypto.randomUUID());
  const cents = parseSoles(amount);
  const account = accounts.find((a) => a.id === accountId);
  const available = balances[accountId] ?? 0;
  const errs = {
    description: description.trim().length < 3 ? 'Describa el movimiento (mínimo 3 caracteres).' : null,
    category: categoryId ? null : 'Elija el tipo de operación.',
    amount: cents === null || cents <= 0 ? 'Ingrese un monto mayor que cero (ejemplo: 25.50).' : !income && account && !account.allowNegative && cents > available ? `Supera el saldo disponible de ${account.name} (${fmtMoney(available)}).` : null,
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (errs.description || errs.category || errs.amount || !accountId) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await post<CashMovement>('/cashbox/movements', {
        flow, accountId, categoryId, description: description.trim(), amountCents: cents, requestKey: key.current,
        ...(operationNumber.trim() ? { operationNumber: operationNumber.trim() } : {}),
        // Si no se tocó la hora, el servidor usa el instante actual.
        ...(whenTouched ? { occurredAt: new Date(`${when}:00-05:00`).toISOString() } : {}),
      });
      onSaved(saved);
    } catch (err) {
      setError(errorText(err));
      if ((err as { status?: number }).status) key.current = crypto.randomUUID();
      setBusy(false);
    }
  };
  const title = income ? 'Nuevo ingreso' : 'Nuevo egreso';
  return (
    <Dialog title={title} onClose={onClose} footer={<><Button onClick={onClose}>Cancelar</Button><Button type="submit" form="cash-form" variant={income ? 'primary' : 'danger'} loading={busy} loadingText="Guardando…">Registrar {income ? 'ingreso' : 'egreso'}</Button></>}>
      <form id="cash-form" onSubmit={(e) => void submit(e)} noValidate style={{ display: 'grid', gap: 'var(--space-4)' }}>
        <TextField label="Descripción" value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} placeholder={income ? 'Ejemplo: Venta de kit de blanqueamiento' : 'Ejemplo: Compra de guantes'} error={touched ? errs.description : null} />
        <SelectField label="Cuenta o medio de pago" value={accountId} onChange={(e) => setAccountId(e.target.value)} help={!income && account ? `Saldo disponible: ${fmtMoney(available)}` : undefined}>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </SelectField>
        <SelectField label="Tipo de operación" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} error={touched ? errs.category : null}>
          <option value="">Elija una opción</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </SelectField>
        <TextField label="Monto (S/)" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" error={touched ? errs.amount : null} />
        <TextField label="Número de operación" optional value={operationNumber} maxLength={40} onChange={(e) => setOperationNumber(e.target.value)} help="Para transferencias, Yape/Plin o tarjeta. No puede repetirse en la misma cuenta." />
        <TextField label="Fecha y hora" type="datetime-local" value={when} max={nowField()} onChange={(e) => { setWhen(e.target.value); setWhenTouched(true); }} help="Hora de Lima. Por defecto, ahora." />
        <TextField label="Responsable del registro" value={me ? `${me.user.firstName} ${me.user.lastName}` : ''} readOnly />
        {error && <p className="field-error" role="alert">{error}</p>}
      </form>
    </Dialog>
  );
}
