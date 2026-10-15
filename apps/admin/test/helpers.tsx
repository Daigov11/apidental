import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { App } from '../src/App';
import { setAccessToken } from '../src/api/client';
import { AuthProvider } from '../src/auth/AuthProvider';
import { ToastProvider } from '../src/ui/feedback';

export interface Call { method: string; path: string; query: URLSearchParams; body: unknown; headers: Record<string, string> }
type Reply = { status?: number; json?: unknown };
type Handler = Reply | ((c: Call) => Reply);

/** API simulada: responde por «MÉTODO /ruta»; lo no definido responde 404 y queda registrado. */
export function mockApi(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const call: Call = { method, path: url.pathname.replace(/^\/v1/, ''), query: url.searchParams, body: init?.body ? JSON.parse(init.body as string) : undefined, headers };
    calls.push(call);
    const h = routes[`${method} ${call.path}`];
    const r: Reply = h === undefined ? { status: 404, json: { message: 'No encontrado' } } : typeof h === 'function' ? h(call) : h;
    const status = r.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(r.json ?? {}), { status, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fn);
  return { calls, fn, called: (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path) };
}

export const USER = { id: 'u-1', email: 'recepcion.demo@apidental.test', firstName: 'Rosa', lastName: 'Demo (recepción)' };
export const CLINIC = { id: 'c-1', name: 'Clínica Demo' };

export const RECEPTION_PERMS = ['appointment:manage', 'appointment:read', 'branch:read', 'clinic:read', 'clinical:view', 'patient:read', 'patient:read_basic', 'patient:write'];
export const DENTIST_PERMS = ['appointment:attend', 'appointment:read', 'branch:read', 'clinic:read', 'clinical:read', 'clinical:write', 'patient:read', 'patient:read_basic'];

export function sessionRoutes(permissions: string[], roles = ['RECEPTIONIST']): Record<string, Handler> {
  return {
    'POST /auth/refresh': { json: { accessToken: 'tok-1' } },
    'GET /auth/me': { json: { user: USER, context: { platform: false, clinic: CLINIC, branch: { id: 'b-1', name: 'Sede Demo' } }, roles, permissions } },
    'GET /branches': { json: [{ id: 'b-1', name: 'Sede Demo' }] },
  };
}

export function renderApp(route = '/') {
  setAccessToken(null);
  return render(
    <MemoryRouter initialEntries={[route]}>
      <ToastProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

export const CASHIER_PERMS = ['appointment:read', 'billing:manage', 'billing:read', 'branch:read', 'charge:manage', 'charge:read', 'clinic:read', 'loyalty:manage', 'loyalty:read', 'patient:read_basic'];
export const SIM = { active: true, label: 'SIMULACIÓN: datos ficticios de demostración. No hay conexión con Apiworking ni con SUNAT.', demoMark: 'DEMO — NO VÁLIDO PARA SUNAT' };
export const STATUS_MOCK = { mode: 'mock', simulation: SIM, scenarios: [{ code: 'ISSUE', label: 'Emitido de inmediato' }, { code: 'REJECT', label: 'Rechazado' }, { code: 'TIMEOUT', label: 'No responde a tiempo (requiere conciliación)' }] };
export const STATUS_OFF = { mode: 'off', simulation: null, scenarios: [] };
