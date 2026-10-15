import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Button } from './Button';
import { TextAreaField } from './fields';
import { errorText } from './feedback';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Atrapa el foco, cierra con Esc y devuelve el foco a quien abrió el panel. */
function useModal(onClose: () => void, initialFocus?: 'cancel') {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const items = () => Array.from(node?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    const start = initialFocus === 'cancel' ? node?.querySelector<HTMLElement>('[data-initial-focus]') : items().find((e) => e.dataset['close'] === undefined);
    (start ?? items()[0] ?? node)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      } else if (e.key === 'Tab') {
        const list = items();
        if (list.length === 0) return;
        const first = list[0]!;
        const last = list[list.length - 1]!;
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return ref;
}

interface ShellProps { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: 480 | 640; initialFocus?: 'cancel' }

/** Modal para confirmaciones y decisiones cortas. */
export function Dialog({ title, onClose, children, footer, initialFocus }: ShellProps) {
  const titleId = useId();
  const ref = useModal(onClose, initialFocus);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <h2 id={titleId} className="h3">{title}</h2>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-footer">{footer}</div>}
      </div>
    </div>
  );
}

/** Panel lateral derecho para crear y editar (el contexto sigue visible). */
export function Drawer({ title, onClose, children, footer, width = 480 }: ShellProps) {
  const titleId = useId();
  const ref = useModal(onClose);
  return (
    <div className="overlay overlay-drawer" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className="drawer" style={{ ['--drawer-width' as string]: `${width}px` }} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <header className="drawer-header">
          <h2 id={titleId} className="h2">{title}</h2>
          <button type="button" className="icon-btn" data-close="" aria-label="Cerrar panel" onClick={onClose}>
            <X size={20} aria-hidden="true" />
          </button>
        </header>
        <div className="drawer-body">{children}</div>
        {footer && <footer className="drawer-footer">{footer}</footer>}
      </div>
    </div>
  );
}

/** Diálogo de motivo (cancelar, marcar ausencia, reprogramar): el motivo es obligatorio (mínimo 3 caracteres). */
export function ReasonDialog({
  title, explain, confirmLabel, danger, onConfirm, onClose,
}: {
  title: string; explain: string; confirmLabel: string; danger?: boolean;
  onConfirm: (reason: string) => Promise<void>; onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invalid = reason.trim().length < 3;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (invalid) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(reason.trim());
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={title}
      onClose={onClose}
      initialFocus={danger ? 'cancel' : undefined}
      footer={
        <>
          <Button onClick={onClose} data-initial-focus="">Volver</Button>
          <Button type="submit" form="reason-form" variant={danger ? 'danger' : 'primary'} loading={busy} loadingText="Guardando…">
            {confirmLabel}
          </Button>
        </>
      }
    >
      <form id="reason-form" onSubmit={submit} noValidate>
        <p className="muted">{explain}</p>
        <TextAreaField
          label="Motivo"
          help="Por ejemplo: «El paciente avisó que no podrá asistir». Mínimo 3 caracteres."
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          onBlur={() => setTouched(true)}
          error={touched && invalid ? 'Escriba el motivo (al menos 3 caracteres).' : null}
          maxLength={300}
        />
        {error && <p className="field-error" role="alert">{error}</p>}
      </form>
    </Dialog>
  );
}
