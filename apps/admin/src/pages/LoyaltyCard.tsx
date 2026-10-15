import { useState } from 'react';
import { ApiError, get, post } from '../api/client';
import type { LoyaltySummary } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { fmtDateTime } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import { Button } from '../ui/Button';
import { TextField } from '../ui/fields';
import { Alert, ErrorState, Loading, SimulatedTag, errorText, useToast } from '../ui/feedback';

/** Saldo de fidelización, canjes y resumen NFC (SIMULADOS, datos ficticios). Solo con autorización del paciente. */
export function LoyaltyCard({ patientId }: { patientId: string }) {
  const { can } = useAuth();
  const toast = useToast();
  const s = useAsync(() => get<LoyaltySummary>(`/loyalty/patients/${patientId}`), [patientId]);
  const [points, setPoints] = useState('');
  const [busy, setBusy] = useState(false);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const data = s.data;
  const n = Number(points);

  const redeem = async () => {
    setBusy(true);
    try {
      await post(`/loyalty/patients/${patientId}/redeem`, { points: n, requestId });
      toast.success(`Canje de ${n} punto(s) registrado (simulación).`);
      setPoints(''); setRequestId(crypto.randomUUID());
    } catch (e) { toast.error(e instanceof ApiError && e.code === 'INSUFFICIENT_POINTS' ? 'El paciente no tiene puntos suficientes.' : errorText(e)); }
    finally { setBusy(false); s.reload(); }
  };

  return (
    <section className="card" aria-labelledby="loy-h" style={{ marginTop: 'var(--space-6)' }}>
      <div className="card-head"><h2 id="loy-h" className="h3">Fidelización</h2><SimulatedTag /></div>
      <p className="caption muted" style={{ marginBottom: 'var(--space-4)' }}>{data?.simulation.label ?? 'SIMULACIÓN: datos ficticios de demostración.'}</p>
      {s.loading && !data && <Loading rows={2} />}
      {s.error != null && <ErrorState error={s.error} onRetry={s.reload} />}
      {data?.consent === 'MISSING' && <Alert tone="warning" title="Sin autorización de fidelización">{data.message}</Alert>}
      {data?.consent === 'GRANTED' && (
        <div className="grid-2">
          <div>
            <p className="muted">Saldo de puntos</p>
            <p className="money">{data.points.balance}</p>
            <p className="caption muted">{data.points.tier} · acumulados {data.points.accrued} · canjeados {data.points.redeemed}</p>
            <p className="caption muted">{data.rule}</p>
            {data.points.recent.length > 0 && (
              <ul className="caption" style={{ paddingLeft: '1.1rem', marginTop: 'var(--space-3)' }}>
                {data.points.recent.map((r, i) => <li key={i}>{r.kindLabel} {r.kind === 'ACCRUAL' ? '+' : '−'}{r.points} · {fmtDateTime(r.at)}</li>)}
              </ul>
            )}
            {can('loyalty:manage') && (
              <form style={{ marginTop: 'var(--space-5)', maxWidth: 260 }} onSubmit={(e) => { e.preventDefault(); if (n >= 1) void redeem(); }}>
                <TextField label="Canjear puntos" inputMode="numeric" value={points} onChange={(e) => setPoints(e.target.value.replace(/\D/g, ''))} help="Canje simulado." />
                <Button type="submit" disabled={!(n >= 1)} loading={busy} loadingText="Canjeando…">Canjear</Button>
              </form>
            )}
          </div>
          <div>
            <p className="muted">Tarjeta NFC</p>
            <p><strong>{data.nfc.cardLabel}</strong></p>
            <dl className="facts" style={{ marginTop: 'var(--space-3)' }}>
              <dt>Estado</dt><dd>{data.nfc.status}</dd>
              <dt>Visitas en 30 días</dt><dd>{data.nfc.tapsLast30Days}</dd>
              <dt>Último uso</dt><dd>{data.nfc.lastTapAt ? fmtDateTime(data.nfc.lastTapAt) : '—'}</dd>
              <dt>Nivel</dt><dd>{data.nfc.tier}</dd>
            </dl>
          </div>
        </div>
      )}
    </section>
  );
}
