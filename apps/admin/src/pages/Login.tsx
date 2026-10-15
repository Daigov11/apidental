import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { Button } from '../ui/Button';
import { TextField } from '../ui/fields';
import { Alert, errorText } from '../ui/feedback';
import logoNegro from '../assets/brand/apimedical-negro.png';
import mascota from '../assets/brand/mascota.png';

export function LoginPage() {
  const { login, notice } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const missing = !email.trim() || !password;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (missing) return;
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password);
    } catch (err) {
      // Mensaje genérico: no revela si el correo existe.
      const text = errorText(err);
      setError(/credencial|incorrect|inválid|invalid/i.test(text) || (err as { status?: number }).status === 401 ? 'Correo o contraseña incorrectos.' : text);
      setBusy(false);
    }
  };

  return (
    <main className="auth-page" id="main">
      <div className="card auth-card">
        <div className="auth-brand">
          <div><img className="auth-logo" src={logoNegro} alt="APIMedical" /><p className="auth-product">ApiDental <span className="muted">by Apiworking</span></p></div>
          <img className="auth-mascot" src={mascota} alt="" aria-hidden="true" />
        </div>
        <h1 className="h2" style={{ margin: 'var(--space-5) 0' }}>Ingrese a su clínica</h1>
        {notice && <Alert tone="warning">{notice}</Alert>}
        {error && <Alert tone="danger">{error}</Alert>}
        <form onSubmit={submit} noValidate>
          <TextField
            label="Correo" type="email" name="username" autoComplete="username" inputMode="email" autoFocus
            value={email} onChange={(e) => setEmail(e.target.value)}
            error={touched && !email.trim() ? 'Escriba su correo, por ejemplo nombre@clinica.pe' : null}
          />
          <TextField
            label="Contraseña" type={show ? 'text' : 'password'} name="password" autoComplete="current-password"
            value={password} onChange={(e) => setPassword(e.target.value)}
            error={touched && !password ? 'Escriba su contraseña' : null}
          />
          <p style={{ margin: '-0.75rem 0 var(--space-6)' }}>
            <button type="button" className="btn btn-tertiary btn-sm" onClick={() => setShow((s) => !s)} aria-pressed={show}>
              {show ? 'Ocultar contraseña' : 'Mostrar contraseña'}
            </button>
          </p>
          <Button type="submit" variant="primary" size="lg" loading={busy} loadingText="Ingresando…" style={{ width: '100%' }}>
            Ingresar
          </Button>
        </form>
        <p className="caption muted" style={{ marginTop: 'var(--space-5)' }}>Los datos de esta pantalla son de uso exclusivo del personal autorizado de la clínica.</p>
      </div>
    </main>
  );
}

export function ContextPage() {
  const { contexts, chooseContext, logout, me } = useAuth();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <main className="auth-page" id="main">
      <div className="card auth-card">
        <h1 className="h2">¿Dónde va a trabajar hoy?</h1>
        <p className="muted" style={{ margin: 'var(--space-3) 0 var(--space-5)' }}>{me ? `Hola, ${me.user.firstName}. ` : ''}Elija la clínica y la sede.</p>
        {error && <Alert tone="danger">{error}</Alert>}
        <ul className="context-list">
          {contexts.map((c) => (
            <li key={c.assignmentId}>
              <button
                type="button" disabled={busy !== null}
                onClick={async () => {
                  setBusy(c.assignmentId); setError(null);
                  try { await chooseContext(c); } catch (e) { setError(errorText(e)); setBusy(null); }
                }}
              >
                <strong>{c.clinic ? `${c.clinic.name} · ${c.branch?.name ?? 'Todas las sedes'}` : 'Administración de la plataforma'}</strong>
                <span className="caption muted">{c.role.name}</span>
              </button>
            </li>
          ))}
        </ul>
        <p style={{ marginTop: 'var(--space-5)' }}><Button variant="tertiary" size="sm" onClick={() => void logout()}>Cerrar sesión</Button></p>
      </div>
    </main>
  );
}
