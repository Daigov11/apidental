import type { Request } from 'express';

/** Contexto activo: clínica (null = plataforma) y sede (null = toda la clínica). */
export interface ActiveContext {
  clinicId: string | null;
  branchId: string | null;
}

export interface PublicUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
}

/** Quién hace la solicitud, con qué contexto y qué permisos efectivos tiene en él. */
export interface AuthPrincipal {
  user: PublicUser;
  /** Sesión de la que proviene el access token (sid). */
  sessionId: string;
  context: ActiveContext | null;
  roles: string[];
  permissions: ReadonlySet<string>;
}

export interface AccessTokenPayload {
  sub: string;
  /** Id de sesión: el token deja de valer cuando la sesión se revoca. */
  sid: string;
  ctx?: ActiveContext;
}

export interface AppRequest extends Request {
  requestId?: string;
  principal?: AuthPrincipal;
  /** Anotado por PermissionsGuard antes de rechazar: alimenta la auditoría de accesos denegados. */
  denial?: { reason: 'no_context' | 'missing_permission'; required: string[] };
}
