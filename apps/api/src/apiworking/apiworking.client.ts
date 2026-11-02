import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../config/app-config.js';

/**
 * Cliente HTTP de Apiworking. Es el ÚNICO lugar por donde sale tráfico hacia Apiworking, y aplica los controles de la
 * guía de integración: lista cerrada de método y ruta, parámetros exactos, tiempo máximo, sin redirecciones, lectura
 * estricta del sobre `{ codResponse, message, data }`, interruptores de lectura y escritura y nada sensible en registros.
 * Las escrituras NUNCA se reintentan: un tiempo agotado no significa que la operación haya fallado.
 */
export const ROUTES = {
  login: { method: 'POST', path: '/api/User/login', kind: 'login' },
  caja: { method: 'GET', path: '/api/Caja', kind: 'read' },
  cajaApertura: { method: 'GET', path: '/api/CajaChica/consulta-aperturada', kind: 'read' },
  tipoDocumentos: { method: 'GET', path: '/api/Caja/tipo-documentos', kind: 'read' },
  series: { method: 'GET', path: '/api/Facturacion/series', kind: 'read' },
  formasPago: { method: 'GET', path: '/api/CajaChica/formas-pago', kind: 'read' },
  clientes: { method: 'GET', path: '/api/Cliente/clientes', kind: 'read' },
  facturacion: { method: 'GET', path: '/api/Facturacion', kind: 'read' },
  controlPagos: { method: 'GET', path: '/api/Facturacion/controlPagos', kind: 'read' },
  registroDocumento: { method: 'POST', path: '/api/Facturacion/registro-documento', kind: 'write' },
  anular: { method: 'POST', path: '/api/Facturacion/anular', kind: 'write' },
  /** Crea o vincula al cliente por documento: tipoDoc y nroDoc van en la query y NO hay cuerpo. El DNI queda en la URL: nunca se registra. */
  clienteDoc: { method: 'POST', path: '/api/Cliente/ClienteDoc', kind: 'write' },
  turnos: { method: 'GET', path: '/api/CajaChica/turnos', kind: 'read' },
  /** El tenant va en la ruta (…/AperturaCajaChica/{base_datos}): siempre es el esperado de esta instalación, nunca un dato libre. */
  aperturaCaja: { method: 'POST', path: '/api/CajaChica/AperturaCajaChica', kind: 'write', tenantInPath: true },
  cierreCaja: { method: 'POST', path: '/api/CajaChica/PostCierreCajaChica', kind: 'write', tenantInPath: true },
} as const;

export type RouteName = keyof typeof ROUTES;

/** Parámetros de consulta aceptados por ruta (cualquier otro se rechaza: nunca se construyen URLs con datos libres). */
const QUERY_PARAMS: Record<RouteName, readonly string[]> = {
  login: [],
  caja: [],
  cajaApertura: ['idCaja'],
  tipoDocumentos: ['idcaja'],
  series: ['idTipoDocumento', 'idCaja'],
  formasPago: ['idMovimientoCaja'],
  clientes: ['bd', 'displayStart', 'displayLength'],
  facturacion: ['idSucursal', 'tipoDoc', 'fechaInicio', 'fechaFin', 'displayStart', 'displayLength', 'allFechas', 'estado', 'search'],
  controlPagos: ['idDocumentoPago'],
  registroDocumento: [],
  anular: ['idDocumentoPago', 'motivoAnulacion', 'usuario'],
  clienteDoc: ['tipoDoc', 'nroDoc'],
  turnos: [],
  aperturaCaja: [],
  cierreCaja: [],
};

export type ApiworkingErrorKind =
  | 'DISABLED' // interruptor apagado o integración sin configurar
  | 'REJECTED' // 200 con codResponse distinto de 1: rechazado por el proveedor
  | 'AUTH' // 401
  | 'FORBIDDEN' // 403
  | 'NOT_FOUND' // 404
  | 'DUPLICATE' // 409
  | 'RATE_LIMIT' // 429
  | 'INVALID' // otro 4xx
  | 'UNKNOWN_RESULT' // 5xx, tiempo agotado, red o respuesta inválida: puede haberse procesado
  | 'BAD_RESPONSE'; // 200 con un sobre que no cumple el contrato (campo ausente = error)

export class ApiworkingError extends Error {
  constructor(
    readonly kind: ApiworkingErrorKind,
    message: string,
    readonly status?: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

export interface ApiworkingCall {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** JWT externo de la sesión (todas las rutas salvo el login). */
  token?: string;
}

/**
 * Convierte los enteros de 15 o más dígitos en texto ANTES de interpretar el JSON: ids como 202600000038 caben, pero
 * otros mayores perderían precisión como número de JavaScript. Respeta el contenido de las cadenas.
 */
export function parseJsonKeepingBigIds(text: string): unknown {
  const fixed = text.replace(/"(?:[^"\\]|\\.)*"|(?<![\d.])-?\d{15,}(?![\d.eE])/g, (m) => (m.startsWith('"') ? m : `"${m}"`));
  return JSON.parse(fixed);
}

const SAFE_MESSAGE = 200;
/** Mensaje del proveedor acotado y sin saltos de línea: puede mostrarse al usuario, nunca se guarda un cuerpo. */
export const clip = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, SAFE_MESSAGE) : '');

@Injectable()
export class ApiworkingClient {
  private readonly logger = new Logger('Apiworking');

  constructor(private readonly config: AppConfig) {}

  /** Llama a una ruta de la lista cerrada y devuelve `data` ya validado como existente. */
  async call(route: RouteName, opts: ApiworkingCall = {}): Promise<unknown> {
    const cfg = this.config.apiworking;
    const def = ROUTES[route];
    if (!cfg.configured) throw new ApiworkingError('DISABLED', 'Apiworking no está configurado en esta instalación');
    if (def.kind === 'read' && !cfg.read) throw new ApiworkingError('DISABLED', 'Las lecturas reales de Apiworking están desactivadas');
    if (def.kind === 'write' && !cfg.write) throw new ApiworkingError('DISABLED', 'Las escrituras reales de Apiworking están desactivadas');
    if (def.kind !== 'login' && !opts.token) throw new ApiworkingError('AUTH', 'Falta la sesión de Apiworking');

    if ('tenantInPath' in def && !cfg.expectedDatabase) throw new ApiworkingError('DISABLED', 'Falta el tenant esperado de esta instalación');
    const path = 'tenantInPath' in def ? `${def.path}/${encodeURIComponent(cfg.expectedDatabase!)}` : def.path;
    const url = new URL(cfg.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v === undefined) continue;
      if (!QUERY_PARAMS[route].includes(k)) throw new Error(`Parámetro no permitido para ${route}: ${k}`);
      url.searchParams.set(k, String(v));
    }

    const headers: Record<string, string> = { accept: 'application/json' };
    if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
    const hasBody = opts.body !== undefined;
    if (hasBody) headers['content-type'] = 'application/json';

    // Lectura: un solo reintento ante un fallo transitorio. Escritura y login: nunca.
    const attempts = def.kind === 'read' ? 2 : 1;
    let lastError: ApiworkingError | null = null;
    for (let i = 0; i < attempts; i++) {
      const started = Date.now();
      try {
        const res = await fetch(url, {
          method: def.method,
          headers,
          body: hasBody ? JSON.stringify(opts.body) : undefined,
          redirect: 'error',
          signal: AbortSignal.timeout(cfg.timeoutMs),
        });
        // Solo ruta, estado y duración: jamás cuerpos, parámetros, cabeceras ni tokens.
        this.logger.log(`${def.method} ${def.path} -> ${res.status} (${Date.now() - started} ms)`);
        return await this.interpret(res);
      } catch (error) {
        const err = error instanceof ApiworkingError ? error : new ApiworkingError('UNKNOWN_RESULT', 'No se obtuvo una respuesta válida de Apiworking');
        if (!(error instanceof ApiworkingError)) this.logger.warn(`${def.method} ${def.path} -> sin respuesta (${Date.now() - started} ms)`);
        lastError = err;
        if (err.kind !== 'UNKNOWN_RESULT') throw err;
      }
    }
    throw lastError!;
  }

  private async interpret(res: Response): Promise<unknown> {
    const retryAfter = Number(res.headers.get('retry-after'));
    switch (true) {
      case res.status === 401:
        throw new ApiworkingError('AUTH', 'Apiworking rechazó la sesión o la credencial', 401);
      case res.status === 403:
        throw new ApiworkingError('FORBIDDEN', 'Apiworking denegó el permiso', 403);
      case res.status === 404:
        throw new ApiworkingError('NOT_FOUND', 'Apiworking no encontró el recurso', 404);
      case res.status === 409:
        throw new ApiworkingError('DUPLICATE', 'Apiworking indica que ya existe', 409);
      case res.status === 429:
        throw new ApiworkingError('RATE_LIMIT', 'Apiworking limitó las solicitudes', 429, Number.isFinite(retryAfter) ? retryAfter : undefined);
      case res.status >= 500:
        throw new ApiworkingError('UNKNOWN_RESULT', 'Apiworking respondió con un error del servidor', res.status);
      case res.status >= 400:
        throw new ApiworkingError('INVALID', 'Apiworking rechazó los datos enviados', res.status);
      case res.status !== 200:
        throw new ApiworkingError('BAD_RESPONSE', 'Respuesta inesperada de Apiworking', res.status);
    }

    let envelope: unknown;
    try {
      envelope = parseJsonKeepingBigIds(await res.text());
    } catch {
      throw new ApiworkingError('UNKNOWN_RESULT', 'Apiworking devolvió una respuesta que no es JSON válido', 200);
    }
    if (typeof envelope !== 'object' || envelope === null || !('codResponse' in envelope)) {
      throw new ApiworkingError('BAD_RESPONSE', 'La respuesta de Apiworking no tiene el formato esperado', 200);
    }
    const { codResponse, message, data } = envelope as { codResponse: unknown; message?: unknown; data?: unknown };
    // HTTP 200 no basta: solo codResponse 1 es éxito; cualquier otro valor tiene significado desconocido.
    if (codResponse !== 1 && codResponse !== '1') {
      throw new ApiworkingError('REJECTED', clip(message) || 'Apiworking rechazó la operación', 200);
    }
    if (data === undefined || data === null) throw new ApiworkingError('BAD_RESPONSE', 'Apiworking no devolvió datos', 200);
    return data;
  }
}

// --- Lectura estricta: un campo ausente o de otro tipo es un error, nunca un valor por defecto ---

export function asRecord(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new ApiworkingError('BAD_RESPONSE', `Apiworking: ${what} no tiene el formato esperado`);
  return v as Record<string, unknown>;
}

/** `data` puede ser una lista o un solo registro: ambos se leen como lista de registros. */
export function asRows(v: unknown, what: string): Record<string, unknown>[] {
  const list = Array.isArray(v) ? v : [v];
  return list.map((x) => asRecord(x, what));
}

/** Id o texto obligatorio: acepta texto o número (los ids grandes ya llegan como texto) y devuelve texto. */
export function reqId(r: Record<string, unknown>, key: string, what: string): string {
  const v = r[key];
  if ((typeof v === 'string' && v.trim() !== '') || (typeof v === 'number' && Number.isFinite(v))) return String(v).trim();
  throw new ApiworkingError('BAD_RESPONSE', `Apiworking: falta ${key} en ${what} (campos recibidos: ${Object.keys(r).slice(0, 30).join(', ') || 'ninguno'})`);
}

/** Id con varios nombres posibles (el contrato no lo fija): acepta el primero presente; si ninguno, el error lista los campos recibidos. */
export function reqIdAny(r: Record<string, unknown>, keys: readonly string[], what: string): string {
  for (const k of keys) {
    const v = r[k];
    if ((typeof v === 'string' && v.trim() !== '') || (typeof v === 'number' && Number.isFinite(v))) return String(v).trim();
  }
  return reqId(r, keys[0]!, what);
}

/** `consulta-aperturada` responde «No se encontraron datos registrados» (codResponse distinto de 1) cuando la caja NO está abierta: es un estado, no un fallo. */
export const isNoData = (error: unknown): boolean => error instanceof ApiworkingError && error.kind === 'REJECTED' && /no se encontr/i.test(error.message);

/** Lista vacía = sin restricción local: vale lo que Apiworking informa a este usuario (el tenant ya está fijado y se revalida en cada envío). */
export const allowed = (list: readonly string[], id: string): boolean => list.length === 0 || list.includes(id);

const CAJA_ID_KEYS = ['idCaja', 'id', 'id_caja', 'IdCaja', 'idcaja'] as const;
const CAJA_NAME_KEYS = ['caja', 'nombreCaja', 'nombre_caja', 'nombre', 'descripcion'] as const;
export const cajaId = (r: Record<string, unknown>) => reqIdAny(r, CAJA_ID_KEYS, 'una caja');
export const cajaName = (r: Record<string, unknown>) => CAJA_NAME_KEYS.map((k) => optText(r, k)).find(Boolean) ?? 'Caja';

export function optText(r: Record<string, unknown>, key: string): string {
  const v = r[key];
  return typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
}

/** Importe con formato variable ("17,069.05" o "17069.05") a céntimos enteros, sin pasar por coma flotante. */
export function moneyToCents(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) : null;
  if (typeof v !== 'string') return null;
  const m = /^\s*(-?)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*$/.exec(v);
  if (!m) return null;
  const whole = Number(m[2]!.replace(/,/g, ''));
  const cents = Number((m[3] ?? '').padEnd(2, '0') || '0');
  const total = whole * 100 + cents;
  return m[1] === '-' ? -total : total;
}
