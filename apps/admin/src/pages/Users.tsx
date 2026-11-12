import { useState } from 'react';
import { Copy, KeyRound, Plus, RefreshCw, UserPlus } from 'lucide-react';
import { get, patch, post } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { fmtDateTime } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import { Button } from '../ui/Button';
import { SelectField, TextField } from '../ui/fields';
import { Alert, Badge, EmptyState, ErrorState, Loading, errorText, useToast } from '../ui/feedback';
import { Dialog, ReasonDialog } from '../ui/overlays';

interface Assignment { id: string; clinicId: string | null; branchId: string | null; status: 'ACTIVE' | 'INACTIVE'; role: { code: string; name: string } }
export interface SystemUser {
  id: string; email: string; firstName: string; lastName: string; status: 'ACTIVE' | 'DISABLED'; lastLoginAt: string | null; createdAt: string;
  externalIdentity: { externalUsername: string } | null; assignments: Assignment[];
}
interface Role { code: string; name: string; scope: 'PLATFORM' | 'CLINIC' }

/** El Director Clínico solo se designa por invitación formal; los roles de plataforma no se otorgan desde una clínica. */
const grantable = (roles: Role[] | null | undefined) => (roles ?? []).filter((r) => r.scope === 'CLINIC' && r.code !== 'CLINICAL_DIRECTOR');

/** Usuarios del sistema: lista, alta con contraseña, restablecimiento, roles y estado. Las contraseñas no se pueden ver: se guardan cifradas. */
export function UsersPage() {
  const { me, can, authMode } = useAuth();
  const toast = useToast();
  const users = useAsync(() => get<SystemUser[]>('/users', { limit: 100 }), []);
  const roles = useAsync(() => (can('role:read') ? get<Role[]>('/roles') : Promise.resolve([] as Role[])), []);
  const canManage = can('user:manage');
  const canAssign = can('assignment:manage');
  const [creating, setCreating] = useState(false);
  const [reveal, setReveal] = useState<{ title: string; login: string; password: string } | null>(null);
  const [resetOf, setResetOf] = useState<SystemUser | null>(null);
  const [assignOf, setAssignOf] = useState<SystemUser | null>(null);
  const [statusOf, setStatusOf] = useState<{ user: SystemUser; op: 'disable' | 'reactivate' } | null>(null);

  const revoke = async (u: SystemUser, a: Assignment) => {
    try { await patch(`/assignments/${a.id}/revoke`); toast.success(`Se quitó el rol ${a.role.name} a ${u.firstName}.`); }
    catch (e) { toast.error(errorText(e)); }
    finally { users.reload(); }
  };

  return (
    <>
      <div className="page-head">
        <div><h1>Usuarios</h1><p className="muted">Quién puede ingresar a este sistema y con qué rol.</p></div>
        <div className="chip-row">
          <Button size="sm" icon={<RefreshCw size={16} aria-hidden="true" />} onClick={users.reload}>Actualizar</Button>
          {canManage && canAssign && <Button variant="primary" icon={<UserPlus size={18} aria-hidden="true" />} onClick={() => setCreating(true)}>Nuevo usuario</Button>}
        </div>
      </div>
      <Alert tone="info" title="Contraseñas">
        Las contraseñas se guardan cifradas y nadie puede verlas, ni siquiera el administrador. Al crear un usuario o restablecer su contraseña, la nueva se muestra <strong>una sola vez</strong>: cópiela y entréguela a la persona.
        {authMode === 'apiworking' && ' Las cuentas de Apiworking ingresan con su usuario y contraseña de Apiworking (se cambian en Apiworking); los usuarios creados aquí ingresan con su correo en «Ingresar con correo».'}
      </Alert>

      {users.loading && !users.data && <Loading rows={4} />}
      {users.error != null && <ErrorState error={users.error} onRetry={users.reload} />}
      {users.data?.length === 0 && <EmptyState title="Sin usuarios">Todavía no hay usuarios en esta clínica.</EmptyState>}
      {users.data && users.data.length > 0 && (
        <div className="table-wrap table-cards" style={{ marginTop: 'var(--space-5)' }}>
          <table>
            <caption className="sr-only">Usuarios del sistema</caption>
            <thead><tr><th scope="col">Nombre</th><th scope="col">Ingresa con</th><th scope="col">Roles</th><th scope="col">Estado</th><th scope="col">Último ingreso</th><th scope="col">Acciones</th></tr></thead>
            <tbody>
              {users.data.map((u) => {
                const self = u.id === me?.user.id;
                const active = u.assignments.filter((a) => a.status === 'ACTIVE');
                return (
                  <tr key={u.id}>
                    <td data-label="Nombre">{u.firstName} {u.lastName}{self && <span className="caption muted"> (usted)</span>}</td>
                    <td data-label="Ingresa con">
                      {u.externalIdentity
                        ? <><Badge tone="info">Apiworking</Badge> <span className="tabular">{u.externalIdentity.externalUsername}</span></>
                        : <span className="tabular">{u.email}</span>}
                    </td>
                    <td data-label="Roles">
                      {active.length === 0 && <Badge tone="warning">Sin rol: no puede operar</Badge>}
                      <div className="chip-row">
                        {active.map((a) => (
                          <span key={a.id} className="chip-row" style={{ gap: 'var(--space-1)' }}>
                            <Badge tone="neutral">{a.role.name}</Badge>
                            {canAssign && !self && a.role.code !== 'CLINICAL_DIRECTOR' && <Button size="sm" variant="tertiary" aria-label={`Quitar el rol ${a.role.name} a ${u.firstName}`} onClick={() => void revoke(u, a)}>Quitar</Button>}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td data-label="Estado"><Badge tone={u.status === 'ACTIVE' ? 'success' : 'danger'}>{u.status === 'ACTIVE' ? 'Activo' : 'Desactivado'}</Badge></td>
                    <td data-label="Último ingreso" className="tabular">{u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : '—'}</td>
                    <td data-label="Acciones">
                      {!self && (
                        <div className="chip-row">
                          {canAssign && u.status === 'ACTIVE' && <Button size="sm" icon={<Plus size={16} aria-hidden="true" />} onClick={() => setAssignOf(u)}>Asignar rol</Button>}
                          {canManage && !u.externalIdentity && u.status === 'ACTIVE' && <Button size="sm" icon={<KeyRound size={16} aria-hidden="true" />} onClick={() => setResetOf(u)}>Restablecer contraseña</Button>}
                          {canManage && u.status === 'ACTIVE' && <Button size="sm" variant="danger" onClick={() => setStatusOf({ user: u, op: 'disable' })}>Desactivar</Button>}
                          {canManage && u.status === 'DISABLED' && <Button size="sm" onClick={() => setStatusOf({ user: u, op: 'reactivate' })}>Reactivar</Button>}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {creating && (
        <NewUserDialog
          roles={grantable(roles.data)} onClose={() => setCreating(false)}
          onCreated={(r, email, typed) => {
            setCreating(false); users.reload();
            if (r.password) setReveal({ title: 'Usuario creado', login: email, password: r.password });
            else toast.success(typed ? 'Usuario creado con la contraseña que escribió.' : 'Usuario creado.');
          }}
        />
      )}
      {resetOf && (
        <ResetDialog
          user={resetOf} onClose={() => setResetOf(null)}
          onDone={(password) => {
            const u = resetOf; setResetOf(null);
            if (password) setReveal({ title: 'Contraseña restablecida', login: u.email, password });
            else toast.success('Contraseña cambiada. Se cerraron sus sesiones abiertas.');
          }}
        />
      )}
      {assignOf && <AssignDialog user={assignOf} roles={grantable(roles.data).filter((r) => !assignOf.assignments.some((a) => a.status === 'ACTIVE' && a.role.code === r.code))} onClose={() => setAssignOf(null)} onDone={() => { setAssignOf(null); users.reload(); toast.success('Rol asignado.'); }} />}
      {statusOf && (
        <ReasonDialog
          title={statusOf.op === 'disable' ? 'Desactivar usuario' : 'Reactivar usuario'} danger={statusOf.op === 'disable'}
          confirmLabel={statusOf.op === 'disable' ? 'Desactivar' : 'Reactivar'} example={statusOf.op === 'disable' ? 'Ya no trabaja en la clínica' : 'Volvió a trabajar en la clínica'}
          explain={statusOf.op === 'disable' ? `${statusOf.user.firstName} ${statusOf.user.lastName} no podrá ingresar y se cerrarán sus sesiones. No se borra nada.` : `${statusOf.user.firstName} ${statusOf.user.lastName} podrá volver a ingresar.`}
          onClose={() => setStatusOf(null)}
          onConfirm={async (reason) => { await post(`/users/${statusOf.user.id}/${statusOf.op}`, { reason }); setStatusOf(null); users.reload(); toast.success(statusOf.op === 'disable' ? 'Usuario desactivado.' : 'Usuario reactivado.'); }}
        />
      )}
      {reveal && <PasswordReveal {...reveal} onClose={() => setReveal(null)} />}
    </>
  );
}

function PasswordChoice({ mode, setMode, password, setPassword }: { mode: 'auto' | 'typed'; setMode: (m: 'auto' | 'typed') => void; password: string; setPassword: (p: string) => void }) {
  return (
    <>
      <SelectField label="Contraseña" value={mode} onChange={(e) => setMode(e.target.value as 'auto' | 'typed')}>
        <option value="auto">Generarla automáticamente (se muestra una vez)</option>
        <option value="typed">Escribirla yo</option>
      </SelectField>
      {mode === 'typed' && <TextField label="Nueva contraseña" help="Mínimo 12 caracteres." type="text" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
    </>
  );
}

function NewUserDialog({ roles, onClose, onCreated }: { roles: Role[]; onClose: () => void; onCreated: (r: { password?: string }, email: string, typed: boolean) => void }) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [roleCode, setRoleCode] = useState('');
  const [mode, setMode] = useState<'auto' | 'typed'>('auto');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invalid = !firstName.trim() || !lastName.trim() || !/^\S+@\S+\.\S+$/.test(email.trim()) || !roleCode || (mode === 'typed' && password.length < 12);
  const submit = async () => {
    if (invalid || busy) return;
    setBusy(true); setError(null);
    try {
      const r = await post<{ password?: string }>('/users', { firstName: firstName.trim(), lastName: lastName.trim(), email: email.trim(), roleCode, ...(mode === 'typed' ? { password } : {}) });
      onCreated(r, email.trim().toLowerCase(), mode === 'typed');
    } catch (e) { setError(errorText(e)); setBusy(false); }
  };
  return (
    <Dialog title="Nuevo usuario" onClose={onClose} footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" disabled={invalid} loading={busy} loadingText="Creando…" onClick={() => void submit()}>Crear usuario</Button></>}>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="row-2">
        <TextField label="Nombres" value={firstName} autoComplete="off" onChange={(e) => setFirstName(e.target.value)} />
        <TextField label="Apellidos" value={lastName} autoComplete="off" onChange={(e) => setLastName(e.target.value)} />
      </div>
      <TextField label="Correo" help="Con este correo ingresará al sistema." type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
      <SelectField label="Rol" value={roleCode} onChange={(e) => setRoleCode(e.target.value)}>
        <option value="">Elija el rol</option>
        {roles.map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}
      </SelectField>
      <PasswordChoice mode={mode} setMode={setMode} password={password} setPassword={setPassword} />
    </Dialog>
  );
}

function ResetDialog({ user, onClose, onDone }: { user: SystemUser; onClose: () => void; onDone: (password?: string) => void }) {
  const [mode, setMode] = useState<'auto' | 'typed'>('auto');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invalid = mode === 'typed' && password.length < 12;
  const submit = async () => {
    if (invalid || busy) return;
    setBusy(true); setError(null);
    try { const r = await post<{ password?: string }>(`/users/${user.id}/password`, mode === 'typed' ? { password } : {}); onDone(r.password); }
    catch (e) { setError(errorText(e)); setBusy(false); }
  };
  return (
    <Dialog title="Restablecer contraseña" onClose={onClose} footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" disabled={invalid} loading={busy} loadingText="Guardando…" onClick={() => void submit()}>Restablecer</Button></>}>
      <p>Se pondrá una contraseña nueva a <strong>{user.firstName} {user.lastName}</strong> ({user.email}). La anterior deja de servir y se cierran sus sesiones abiertas.</p>
      {error && <Alert tone="danger">{error}</Alert>}
      <PasswordChoice mode={mode} setMode={setMode} password={password} setPassword={setPassword} />
    </Dialog>
  );
}

function AssignDialog({ user, roles, onClose, onDone }: { user: SystemUser; roles: Role[]; onClose: () => void; onDone: () => void }) {
  const [roleCode, setRoleCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!roleCode || busy) return;
    setBusy(true); setError(null);
    try { await post('/assignments', { userId: user.id, roleCode }); onDone(); }
    catch (e) { setError(errorText(e)); setBusy(false); }
  };
  return (
    <Dialog title="Asignar rol" onClose={onClose} footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" disabled={!roleCode} loading={busy} loadingText="Asignando…" onClick={() => void submit()}>Asignar</Button></>}>
      <p>Rol para <strong>{user.firstName} {user.lastName}</strong>{user.externalIdentity ? ` (Apiworking: ${user.externalIdentity.externalUsername})` : ''} en esta clínica.</p>
      {error && <Alert tone="danger">{error}</Alert>}
      <SelectField label="Rol" value={roleCode} onChange={(e) => setRoleCode(e.target.value)}>
        <option value="">Elija el rol</option>
        {roles.map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}
      </SelectField>
    </Dialog>
  );
}

function PasswordReveal({ title, login, password, onClose }: { title: string; login: string; password: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(password); setCopied(true); } catch { setCopied(false); }
  };
  return (
    <Dialog title={title} onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Ya la copié</Button>}>
      <Alert tone="warning">Esta contraseña se muestra <strong>solo ahora</strong>. Cópiela y entréguela a la persona; después no se podrá volver a ver.</Alert>
      <dl className="facts" style={{ margin: 'var(--space-4) 0' }}>
        <dt>Ingresa con</dt><dd className="tabular">{login}</dd>
        <dt>Contraseña</dt><dd className="tabular" style={{ fontSize: '1.25rem', letterSpacing: '0.05em' }} aria-label="Contraseña">{password}</dd>
      </dl>
      <Button size="sm" icon={<Copy size={16} aria-hidden="true" />} onClick={() => void copy()}>{copied ? 'Copiada' : 'Copiar contraseña'}</Button>
    </Dialog>
  );
}
