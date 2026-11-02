import { Injectable } from '@nestjs/common';

export interface ExternalSession {
  /** Usuario local dueño de la sesión (para cerrar todas sus sesiones externas a la vez). */
  userId: string;
  token: string;
  /** id_sucursal de Apiworking del usuario (para consultar documentos). */
  branchId: string | null;
  /** Usuario de Apiworking (el campo `usuario` del login): lo exige la anulación. */
  username: string;
  expiresAt: number;
}

const MAX_LOCAL_LIFETIME_MS = 12 * 60 * 60 * 1000;
const MAX_ENTRIES = 5000;

/**
 * JWT externo en MEMORIA del servidor, atado a la sesión local: jamás llega al navegador ni se guarda en la base de
 * datos. Un reinicio de la API lo borra (el usuario sigue en el sistema pero debe volver a entrar para operar con
 * Apiworking). No hay renovación de token conocida. `exp` se lee SIN verificar la firma y solo para ACORTAR la vigencia.
 */
@Injectable()
export class ApiworkingSessionStore {
  private readonly sessions = new Map<string, ExternalSession>();

  set(sessionId: string, value: Omit<ExternalSession, 'expiresAt'>, now = Date.now()): void {
    if (this.sessions.size >= MAX_ENTRIES) this.sweep(now);
    if (this.sessions.size >= MAX_ENTRIES) this.sessions.delete(this.sessions.keys().next().value as string);
    this.sessions.set(sessionId, { ...value, expiresAt: Math.min(now + MAX_LOCAL_LIFETIME_MS, readExp(value.token) ?? Infinity) });
  }

  get(sessionId: string, now = Date.now()): ExternalSession | null {
    const s = this.sessions.get(sessionId);
    if (!s) return null;
    if (s.expiresAt <= now) {
      this.sessions.delete(sessionId);
      return null;
    }
    return s;
  }

  delete(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  deleteForUser(userId: string): void {
    for (const [id, s] of this.sessions) if (s.userId === userId) this.sessions.delete(id);
  }

  private sweep(now: number): void {
    for (const [id, s] of this.sessions) if (s.expiresAt <= now) this.sessions.delete(id);
  }
}

/** `exp` del JWT en milisegundos, sin verificar la firma (no se confía en él: solo acorta la vigencia local). */
export function readExp(jwt: string): number | null {
  const part = jwt.split('.')[1];
  if (!part) return null;
  try {
    const exp = (JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { exp?: unknown }).exp;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}
