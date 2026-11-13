import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { MessageCircle, RefreshCw } from 'lucide-react';
import { get, post } from '../api/client';
import { useAsync } from '../lib/useAsync';
import { Button } from '../ui/Button';
import { TextAreaField, TextField } from '../ui/fields';
import { Alert, Badge, ErrorState, Loading, errorText, useToast } from '../ui/feedback';
import { Dialog } from '../ui/overlays';

export interface WaStatus { phoneLabel: string; status: string; statusLabel: string; phoneNumber: string | null; qr: string | null }
interface WaDraft { phone: string | null; text: string; context: 'sale' | 'appointment'; refId: string; hasLink: boolean }
interface WaResult { status: 'SENT' | 'UNCONFIRMED'; message: string; messageId?: string | null }

const TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = { connected: 'success', qr_pending: 'warning', disconnected: 'neutral', banned: 'danger' };
const POLL_MS = 3000;
const POLL_LIMIT_MS = 3 * 60_000;

/** Vincular el WhatsApp de la clínica (solo administración): estado, número y QR para escanear desde el teléfono. */
export function WhatsappPage() {
  const toast = useToast();
  const st = useAsync(() => get<WaStatus>('/apiworking/whatsapp/status'), []);
  const [qr, setQr] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const stop = () => { if (timer.current) clearInterval(timer.current); timer.current = null; };
  useEffect(() => stop, []);

  const link = async () => {
    setLinking(true); setError(null); stop();
    try {
      const r = await post<WaStatus>('/apiworking/whatsapp/link');
      if (r.status === 'connected') { setQr(null); toast.success('WhatsApp ya está vinculado.'); st.reload(); return; }
      if (!r.qr) { setError('Apiworking no devolvió el código QR. Intente de nuevo.'); return; }
      setQr(await QRCode.toDataURL(r.qr, { margin: 1, width: 280 }));
      // Mientras escanean: estado cada 3 s, hasta que conecte (o 3 minutos).
      const started = Date.now();
      timer.current = setInterval(() => {
        if (Date.now() - started > POLL_LIMIT_MS) { stop(); setQr(null); setError('El código QR venció. Pulse «Vincular teléfono» para generar otro.'); return; }
        get<WaStatus>('/apiworking/whatsapp/status').then((s) => {
          if (s.status === 'connected') { stop(); setQr(null); toast.success('WhatsApp vinculado.'); st.reload(); }
        }).catch(() => undefined);
      }, POLL_MS);
    } catch (e) { setError(errorText(e)); }
    finally { setLinking(false); }
  };

  const s = st.data;
  return (
    <>
      <div className="page-head">
        <div><h1>WhatsApp</h1><p className="muted">El número de la clínica con el que se envían comprobantes y recordatorios de cita.</p></div>
        <Button size="sm" icon={<RefreshCw size={16} aria-hidden="true" />} onClick={st.reload}>Actualizar</Button>
      </div>
      {st.loading && !s && <Loading rows={2} />}
      {st.error != null && <ErrorState error={st.error} onRetry={st.reload} />}
      {s && (
        <section className="card" aria-labelledby="wa-h">
          <div className="card-head"><h2 id="wa-h" className="h3">Teléfono de la clínica</h2><Badge tone={TONE[s.status] ?? 'neutral'}>{s.statusLabel}</Badge></div>
          {s.phoneNumber && <p>Número vinculado: <strong className="tabular">{s.phoneNumber}</strong></p>}
          {s.status === 'banned' && <Alert tone="danger">WhatsApp bloqueó este número. Vincule otro número.</Alert>}
          {s.status !== 'connected' && !qr && (
            <>
              <p className="muted">Pulse «Vincular teléfono» y escanee el código con el WhatsApp de la clínica: Ajustes → Dispositivos vinculados → Vincular un dispositivo.</p>
              <Button variant="primary" icon={<MessageCircle size={18} aria-hidden="true" />} loading={linking} loadingText="Generando QR…" onClick={() => void link()}>Vincular teléfono</Button>
            </>
          )}
          {qr && (
            <div style={{ marginTop: 'var(--space-4)' }}>
              <img src={qr} width={280} height={280} alt="Código QR para vincular WhatsApp" style={{ background: '#fff', padding: 8, borderRadius: 8 }} />
              <p className="caption muted" role="status">Esperando que escaneen el código… (se actualiza solo)</p>
              <Button size="sm" variant="tertiary" onClick={() => { stop(); setQr(null); }}>Cancelar</Button>
            </div>
          )}
          {error && <Alert tone="danger">{error}</Alert>}
          <p className="caption muted" style={{ marginTop: 'var(--space-4)' }}>Etiqueta del teléfono en Apiworking: <span className="tabular">{s.phoneLabel}</span></p>
        </section>
      )}
    </>
  );
}

/** Enviar por WhatsApp una venta (comprobante) o una cita (recordatorio): el texto viene armado y se puede editar. */
export function SendWhatsappDialog({ saleId, appointmentId, onClose }: { saleId?: string; appointmentId?: string; onClose: () => void }) {
  const toast = useToast();
  const draft = useAsync(() => get<WaDraft>('/apiworking/whatsapp/draft', saleId ? { saleId } : { appointmentId }), [saleId, appointmentId]);
  const [phone, setPhone] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null);
  const sending = useRef(false);
  const d = draft.data;
  const ph = phone ?? d?.phone ?? '';
  const tx = text ?? d?.text ?? '';
  const invalid = !d || ph.replace(/\D/g, '').length < 8 || !tx.trim();
  const send = async () => {
    if (invalid || sending.current) return;
    sending.current = true; setBusy(true); setError(null); setWarn(null);
    try {
      const r = await post<WaResult>('/apiworking/whatsapp/send', { phone: ph, text: tx, context: d!.context, refId: d!.refId });
      if (r.status === 'SENT') { toast.success('Mensaje enviado por WhatsApp.'); onClose(); }
      else setWarn(r.message);
    } catch (e) { setError(errorText(e)); sending.current = false; }
    finally { setBusy(false); }
  };
  return (
    <Dialog title="Enviar por WhatsApp" onClose={onClose} footer={<><Button onClick={onClose}>Cerrar</Button><Button variant="primary" icon={<MessageCircle size={18} aria-hidden="true" />} disabled={invalid || Boolean(warn)} loading={busy} loadingText="Enviando…" onClick={() => void send()}>Enviar</Button></>}>
      {draft.loading && !d && <Loading rows={2} />}
      {draft.error != null && <ErrorState error={draft.error} onRetry={draft.reload} />}
      {d && (
        <>
          {!d.phone && <Alert tone="info">No hay un celular registrado: escríbalo.</Alert>}
          {d.context === 'sale' && !d.hasLink && <Alert tone="info">El comprobante aún no tiene PDF oficial en Apiworking: el mensaje va sin link.</Alert>}
          <TextField label="Celular" help="9 dígitos (Perú) o con código de país." inputMode="tel" autoComplete="off" value={ph} onChange={(e) => setPhone(e.target.value)} />
          <TextAreaField label="Mensaje" maxLength={1000} rows={6} value={tx} onChange={(e) => setText(e.target.value)} />
          {error && <Alert tone="danger">{error}</Alert>}
          {warn && <Alert tone="warning">{warn}</Alert>}
        </>
      )}
    </Dialog>
  );
}
