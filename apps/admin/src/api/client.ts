/**
 * Cliente de la API. El token de acceso vive SOLO en memoria (nunca en localStorage/sessionStorage). La renovación usa
 * la cookie HttpOnly del refresh token y está serializada: varias solicitudes que reciben 401 a la vez comparten una
 * sola renovación. La URL base es relativa (`/v1`): en desarrollo la reenvía Vite y en producción, Nginx; así la cookie
 * y la protección CSRF funcionan en el mismo origen.
 */
export const API_BASE = '/v1';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
let sessionLost: (() => void) | null = null;

export const setAccessToken = (t: string | null): void => {
  accessToken = t;
};
export const hasAccessToken = (): boolean => accessToken !== null;
export const onSessionLost = (fn: (() => void) | null): void => {
  sessionLost = fn;
};

interface Options {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
  /** No intenta renovar ni envía el token (login, renovación). */
  anonymous?: boolean;
}

function url(path: string, query?: Options['query']): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  const s = q.toString();
  return `${API_BASE}${path}${s ? `?${s}` : ''}`;
}

async function send(method: string, path: string, o: Options): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (o.body !== undefined) headers['Content-Type'] = 'application/json';
  if (!o.anonymous && accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
  // La cabecera de la protección CSRF se envía siempre; sin la cookie no hace nada.
  headers['X-Requested-With'] = 'ApiDental';
  return fetch(url(path, o.query), {
    method,
    headers,
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
    credentials: 'same-origin',
    cache: 'no-store',
    signal: o.signal,
  });
}

/** Renueva el token de acceso con la cookie. Devuelve false si la sesión ya no existe. */
export function refreshAccessToken(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const res = await send('POST', '/auth/refresh', { anonymous: true, body: {} });
      if (!res.ok) return false;
      const data = (await res.json()) as { accessToken?: string };
      if (!data.accessToken) return false;
      accessToken = data.accessToken;
      return true;
    } catch {
      return false;
    } finally {
      setTimeout(() => (refreshing = null), 0);
    }
  })();
  return refreshing;
}

async function toError(res: Response): Promise<ApiError> {
  let message = '';
  let code: string | undefined;
  let requestId: string | undefined;
  try {
    const b = (await res.json()) as { message?: string | string[]; code?: string; requestId?: string };
    message = Array.isArray(b.message) ? (b.message[0] ?? '') : (b.message ?? '');
    code = b.code;
    requestId = b.requestId;
  } catch {
    // cuerpo no JSON: se usa el mensaje genérico
  }
  // Nunca se muestran al usuario mensajes de infraestructura (5xx) ni textos técnicos.
  if (res.status >= 500) message = 'No pudimos completar la operación. Intente de nuevo en unos minutos.';
  else if (res.status === 429) message = 'Demasiados intentos. Espere un minuto e intente de nuevo.';
  else if (!message) message = 'No se pudo completar la solicitud.';
  return new ApiError(res.status, message, code, requestId);
}

export async function api<T>(method: string, path: string, o: Options = {}): Promise<T> {
  let res: Response;
  try {
    res = await send(method, path, o);
  } catch {
    throw new ApiError(0, 'No hay conexión con el servidor. Revise su conexión e intente de nuevo.');
  }
  if (res.status === 401 && !o.anonymous) {
    if (await refreshAccessToken()) res = await send(method, path, o);
    if (res.status === 401) {
      accessToken = null;
      sessionLost?.();
    }
  }
  if (!res.ok) throw await toError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const get = <T>(path: string, query?: Options['query'], signal?: AbortSignal) => api<T>('GET', path, { query, signal });
export const post = <T>(path: string, body: unknown = {}, o: Options = {}) => api<T>('POST', path, { ...o, body });

/** Descarga autenticada (PDF/SVG del odontograma): devuelve el archivo como Blob; nunca hay URL pública. */
export async function getBlob(path: string, query?: Options['query']): Promise<Blob> {
  const attempt = () => fetch(url(path, query), { headers: { Authorization: `Bearer ${accessToken ?? ''}` }, credentials: 'same-origin', cache: 'no-store' });
  let res = await attempt().catch(() => {
    throw new ApiError(0, 'No hay conexión con el servidor. Revise su conexión e intente de nuevo.');
  });
  if (res.status === 401 && (await refreshAccessToken())) res = await attempt();
  if (!res.ok) throw await toError(res);
  return res.blob();
}
