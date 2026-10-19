import { Fragment, useState, type FormEvent } from 'react';
import { post } from '../../api/client';
import type { CashSummary } from '../../api/types';
import { centsToField, fmtMoney, parseSoles } from '../../lib/money';
import { Button } from '../../ui/Button';
import { TextAreaField, TextField } from '../../ui/fields';
import { errorText } from '../../ui/feedback';
import { Dialog } from '../../ui/overlays';

/** Apertura: el saldo inicial de cada cuenta parte del saldo con que cerró la caja; cambiarlo exige explicación. */
export function OpenCashDialog({ summary, onClose, onDone }: { summary: CashSummary; onClose: () => void; onDone: () => void }) {
  const accounts = summary.accounts.filter((a) => a.active);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(accounts.map((a) => [a.id, centsToField(a.balanceCents)])));
  const [notes, setNotes] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsed = accounts.map((a) => ({ a, cents: parseSoles(values[a.id] ?? '') }));
  const invalid = parsed.some((p) => p.cents === null);
  const changed = parsed.some((p) => p.cents !== null && p.cents !== p.a.balanceCents);
  const needsNotes = Boolean(summary.lastClosedAt) && changed;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (invalid || (needsNotes && notes.trim().length < 3)) return;
    setBusy(true);
    setError(null);
    try {
      await post('/cashbox/open', { openings: parsed.map((p) => ({ accountId: p.a.id, amountCents: p.cents })), ...(notes.trim() ? { notes: notes.trim() } : {}) });
      onDone();
    } catch (err) { setError(errorText(err)); setBusy(false); }
  };
  return (
    <Dialog title="Abrir caja" onClose={onClose} footer={<><Button onClick={onClose}>Cancelar</Button><Button type="submit" form="open-form" variant="primary" loading={busy} loadingText="Abriendo…">Abrir caja</Button></>}>
      <form id="open-form" onSubmit={(e) => void submit(e)} noValidate style={{ display: 'grid', gap: 'var(--space-4)' }}>
        <p className="muted">{summary.lastClosedAt ? 'Confirme el saldo inicial de cada cuenta. Parte del saldo con que cerró la caja.' : 'Es la primera apertura de esta caja: indique el saldo inicial de cada cuenta (puede ser cero).'}</p>
        {parsed.map(({ a, cents }) => (
          <TextField key={a.id} label={`${a.name} (S/)`} inputMode="decimal" value={values[a.id] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [a.id]: e.target.value }))} error={touched && cents === null ? 'Ingrese un monto válido (0 o más).' : null} />
        ))}
        <TextAreaField label="Notas" optional={!needsNotes} value={notes} maxLength={300} onChange={(e) => setNotes(e.target.value)} help={needsNotes ? 'El saldo inicial difiere del cierre anterior: explique el motivo.' : undefined} error={touched && needsNotes && notes.trim().length < 3 ? 'Explique la diferencia.' : null} />
        {error && <p className="field-error" role="alert">{error}</p>}
      </form>
    </Dialog>
  );
}

/** Cierre con conciliación: se cuenta el efectivo físico y se compara con el esperado. */
export function CloseCashDialog({ summary, onClose, onDone }: { summary: CashSummary; onClose: () => void; onDone: (differenceCents: number) => void }) {
  const cash = summary.accounts.filter((a) => a.kind === 'CASH' && a.active);
  const others = summary.accounts.filter((a) => a.kind !== 'CASH' && (a.active || a.balanceCents !== 0));
  const [values, setValues] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rows = cash.map((a) => { const counted = parseSoles(values[a.id] ?? ''); return { a, counted, diff: counted === null ? null : counted - a.balanceCents }; });
  const totalDiff = rows.reduce((s, r) => s + (r.diff ?? 0), 0);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (rows.some((r) => r.counted === null) || (totalDiff !== 0 && notes.trim().length < 3)) return;
    setBusy(true);
    setError(null);
    try {
      await post('/cashbox/close', { counts: rows.map((r) => ({ accountId: r.a.id, countedCents: r.counted })), ...(notes.trim() ? { notes: notes.trim() } : {}) });
      onDone(totalDiff);
    } catch (err) { setError(errorText(err)); setBusy(false); }
  };
  return (
    <Dialog title="Cerrar caja" onClose={onClose} footer={<><Button onClick={onClose}>Cancelar</Button><Button type="submit" form="close-form" variant="primary" loading={busy} loadingText="Cerrando…">Cerrar caja</Button></>}>
      <form id="close-form" onSubmit={(e) => void submit(e)} noValidate style={{ display: 'grid', gap: 'var(--space-4)' }}>
        <p className="muted">Cuente el efectivo que hay en la caja e ingréselo. Si no coincide con lo esperado, se registra un ajuste y queda en el reporte.</p>
        {rows.map(({ a, counted, diff }) => (
          <div key={a.id}>
            <TextField label={`${a.name}: efectivo contado (S/)`} inputMode="decimal" value={values[a.id] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [a.id]: e.target.value }))} help={`Esperado: ${fmtMoney(a.balanceCents)}`} error={touched && counted === null ? 'Ingrese el efectivo contado.' : null} />
            {diff !== null && <p role="status" className={diff === 0 ? 'amount-in' : 'amount-out'} style={{ fontWeight: 600 }}>{diff === 0 ? 'Conciliado: sin diferencia.' : diff > 0 ? `Sobrante de ${fmtMoney(diff)}` : `Faltante de ${fmtMoney(-diff)}`}</p>}
          </div>
        ))}
        {others.length > 0 && (
          <dl className="facts" aria-label="Saldos de otras cuentas">
            {others.map((a) => <Fragment key={a.id}><dt>{a.name}</dt><dd className="tabular">{fmtMoney(a.balanceCents)}</dd></Fragment>)}
          </dl>
        )}
        <TextAreaField label="Notas del cierre" optional={totalDiff === 0} value={notes} maxLength={300} onChange={(e) => setNotes(e.target.value)} error={touched && totalDiff !== 0 && notes.trim().length < 3 ? 'Explique la diferencia.' : null} />
        {error && <p className="field-error" role="alert">{error}</p>}
      </form>
    </Dialog>
  );
}
