import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

export interface MenuItem { key: string; label: string; icon?: ReactNode; onSelect: () => void; disabled?: boolean; hint?: string; separatorBefore?: boolean }

/** Botón desplegable accesible (menú de acciones): flechas, Inicio/Fin, Esc y clic fuera. */
export function ActionMenu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const buttons = () => Array.from(wrap.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? []);
  useEffect(() => {
    if (!open) return;
    buttons()[0]?.focus();
    const away = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  const onKey = (e: React.KeyboardEvent) => {
    const list = buttons();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); trigger.current?.focus(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
    else if (e.key === 'Home') { e.preventDefault(); list[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); list[list.length - 1]?.focus(); }
    else if (e.key === 'Tab') setOpen(false);
  };
  return (
    <div className="menu-wrap" ref={wrap} onKeyDown={open ? onKey : undefined}>
      <button ref={trigger} type="button" className="btn btn-primary btn-md" aria-haspopup="menu" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        <span>{label}</span><ChevronDown size={18} aria-hidden="true" />
      </button>
      {open && (
        <div className="menu" id={id} role="menu" aria-label={label}>
          {items.map((it) => (
            <div key={it.key} role="none">
              {it.separatorBefore && <hr className="menu-sep" />}
              <button type="button" role="menuitem" className="menu-item" disabled={it.disabled} title={it.hint} onClick={() => { setOpen(false); it.onSelect(); }}>
                {it.icon}<span>{it.label}</span>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
