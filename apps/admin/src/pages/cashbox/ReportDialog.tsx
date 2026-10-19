import { useState } from 'react';
import { Download } from 'lucide-react';
import { downloadFile } from '../../lib/download';
import { limaDate } from '../../lib/format';
import { Button } from '../../ui/Button';
import { TextField } from '../../ui/fields';
import { errorText } from '../../ui/feedback';
import { Dialog } from '../../ui/overlays';

export function ReportDialog({ onClose }: { onClose: () => void }) {
  const today = limaDate();
  const [from, setFrom] = useState(`${today.slice(0, 8)}01`);
  const [to, setTo] = useState(today);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bad = !from || !to || to < from ? 'La fecha final no puede ser anterior a la inicial.' : null;
  const run = async () => {
    if (bad) return;
    setBusy(true);
    setError(null);
    try { await downloadFile('/cashbox/report', { from, to }, `caja-chica-${from}-a-${to}.pdf`); onClose(); } catch (e) { setError(errorText(e)); setBusy(false); }
  };
  return (
    <Dialog title="Exportar reporte en PDF" onClose={onClose} footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" icon={<Download size={18} aria-hidden="true" />} loading={busy} loadingText="Preparando…" onClick={() => void run()}>Descargar PDF</Button></>}>
      <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
        <p className="muted">Incluye los movimientos del rango, ingresos y egresos acumulados, saldo inicial y final, y el desglose por medio de pago.</p>
        <TextField label="Desde" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        <TextField label="Hasta" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} error={bad} />
        {error && <p className="field-error" role="alert">{error}</p>}
      </div>
    </Dialog>
  );
}
