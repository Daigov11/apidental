import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Loader2 } from 'lucide-react';

type Variant = 'primary' | 'secondary' | 'tertiary' | 'danger';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md' | 'lg';
  /** Muestra el spinner y el texto de progreso manteniendo el ancho. */
  loading?: boolean;
  loadingText?: string;
  icon?: ReactNode;
}

export function Button({ variant = 'secondary', size = 'md', loading, loadingText, icon, children, className = '', disabled, ...rest }: Props) {
  return (
    <button
      type="button"
      {...rest}
      className={`btn btn-${variant} btn-${size} ${className}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading ? <Loader2 className="spin" size={18} aria-hidden="true" /> : icon}
      <span>{loading && loadingText ? loadingText : children}</span>
    </button>
  );
}
