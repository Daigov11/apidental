import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { AlertCircle } from 'lucide-react';

interface FieldProps {
  label: string;
  help?: string;
  error?: string | null;
  optional?: boolean;
}

function Wrapper({ id, label, help, error, optional, children }: FieldProps & { id: string; children: ReactNode }) {
  return (
    <div className="field">
      <label htmlFor={id} className="field-label">
        {label}
        {optional && <span className="field-optional"> (opcional)</span>}
      </label>
      {children}
      {help && !error && (
        <p className="field-help" id={`${id}-help`}>
          {help}
        </p>
      )}
      {error && (
        <p className="field-error" id={`${id}-err`} role="alert">
          <AlertCircle size={16} aria-hidden="true" /> {error}
        </p>
      )}
    </div>
  );
}

const describe = (id: string, help?: string, error?: string | null) => (error ? `${id}-err` : help ? `${id}-help` : undefined);

export function TextField({ label, help, error, optional, ...rest }: FieldProps & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <Wrapper id={id} label={label} help={help} error={error} optional={optional}>
      <input {...rest} id={id} className="input" aria-invalid={error ? true : undefined} aria-describedby={describe(id, help, error)} />
    </Wrapper>
  );
}

export function SelectField({ label, help, error, optional, children, ...rest }: FieldProps & SelectHTMLAttributes<HTMLSelectElement>) {
  const id = useId();
  return (
    <Wrapper id={id} label={label} help={help} error={error} optional={optional}>
      <select {...rest} id={id} className="input" aria-invalid={error ? true : undefined} aria-describedby={describe(id, help, error)}>
        {children}
      </select>
    </Wrapper>
  );
}

export function TextAreaField({ label, help, error, optional, ...rest }: FieldProps & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const id = useId();
  return (
    <Wrapper id={id} label={label} help={help} error={error} optional={optional}>
      <textarea {...rest} id={id} className="input" rows={3} aria-invalid={error ? true : undefined} aria-describedby={describe(id, help, error)} />
    </Wrapper>
  );
}
