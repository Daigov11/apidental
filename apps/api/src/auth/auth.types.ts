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
  context: ActiveContext | null;
  roles: string[];
  permissions: ReadonlySet<string>;
}

export interface AccessTokenPayload {
  sub: string;
  ctx?: ActiveContext;
}

export interface AppRequest extends Request {
  requestId?: string;
  principal?: AuthPrincipal;
}
