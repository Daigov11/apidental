import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, Check, Circle, Diamond, Info, Minus, X, XCircle } from 'lucide-react';
import type { AppointmentStatus } from '../api/types';
import { ApiError } from '../api/client';
import { Button } from './Button';

type Tone = 'info' | 'brand' | 'success' | 'neutral' | 'danger' | 'warning' | 'accent';

/** Insignia de estado: icono + texto (nunca solo color). */
export function Badge({ tone, icon, children }: { tone: Tone; icon?: ReactNode; children: ReactNode }) {
  return (
    <span className={`badge badge-${tone}`}>
      {icon}
      {children}
    </span>
  );
}

const APPT: Record<AppointmentStatus, { tone: Tone; icon: ReactNode }> = {
  RESERVED: { tone: 'info', icon: <Circle size={14} aria-hidden="true" /> },
  CONFIRMED: { tone: 'brand', icon: <Diamond size={14} aria-hidden="true" /> },
  ATTENDED: { tone: 'success', icon: <Check size={14} aria-hidden="true" /> },
  CANCELLED: { tone: 'neutral', icon: <Minus size={14} aria-hidden="true" /> },
  NO_SHOW: { tone: 'danger', icon: <X size={14} aria-hidden="true" /> },
};

export function StatusBadge({ status, label }: { status: AppointmentStatus; label: string }) {
  const s = APPT[status];
  return (
    <Badge tone={s.tone} icon={s.icon}>
      {label}
    </Badge>
  );
}

export function Alert({ tone = 'info', title, children, action }: { tone?: 'info' | 'warning' | 'danger' | 'success'; title?: string; children?: ReactNode; action?: ReactNode }) {
  const Icon = tone === 'danger' ? XCircle : tone === 'warning' ? AlertTriangle : tone === 'success' ? Check : Info;
  return (
    <div className={`alert alert-${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      <Icon size={20} aria-hidden="true" />
      <div className="alert-body">
        {title && <strong>{title}</strong>}
        {children && <div>{children}</div>}
      </div>
      {action}
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {icon}
      <p className="empty-title">{title}</p>
      {children && <p className="muted">{children}</p>}
      {action}
    </div>
  );
}

export function Loading({ label = 'Cargando…', rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className="skeleton-list">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton-row" aria-hidden="true" />
      ))}
    </div>
  );
}

/** Mensaje amigable para el usuario; nunca texto técnico. Con `requestId` para soporte. */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.status === 403 ? 'No tiene acceso a esta información.' : e.message;
  return 'No pudimos completar la operación. Intente de nuevo.';
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const denied = error instanceof ApiError && error.status === 403;
  const requestId = error instanceof ApiError ? error.requestId : undefined;
  return (
    <div className="empty" role="alert">
      <XCircle size={32} aria-hidden="true" />
      <p className="empty-title">{denied ? 'Acceso denegado' : 'No se pudo cargar'}</p>
      <p className="muted">{denied ? 'Su rol no incluye esta información. Si la necesita, consulte con el administrador de su clínica.' : errorText(error)}</p>
      {requestId && !denied && <p className="caption muted">Código de soporte: {requestId}</p>}
      {onRetry && !denied && (
        <Button onClick={onRetry} variant="secondary">
          Reintentar
        </Button>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ avisos (toasts)
interface Toast { id: number; kind: 'success' | 'error'; text: string }
interface ToastApi { success: (t: string) => void; error: (t: string) => void }
const ToastCtx = createContext<ToastApi | null>(null);
export const useToast = (): ToastApi => {
  const v = useContext(ToastCtx);
  if (!v) throw new Error('useToast fuera de ToastProvider');
  return v;
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setItems((l) => l.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (kind: Toast['kind'], text: string) => {
      const id = Date.now() + Math.random();
      setItems((l) => [...l, { id, kind, text }]);
      // Los errores no desaparecen solos.
      if (kind === 'success') setTimeout(() => dismiss(id), 5000);
    },
    [dismiss],
  );
  const api = useMemo<ToastApi>(() => ({ success: (t) => push('success', t), error: (t) => push('error', t) }), [push]);
  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div className="toasts">
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
            {t.kind === 'success' ? <Check size={18} aria-hidden="true" /> : <XCircle size={18} aria-hidden="true" />}
            <span>{t.text}</span>
            <button type="button" className="icon-btn" aria-label="Cerrar aviso" onClick={() => dismiss(t.id)}>
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
