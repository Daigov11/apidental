import { createHash, randomBytes } from 'node:crypto';

/**
 * Tokens opacos de un solo propósito (refresh, invitación, reautenticación).
 * 256 bits de entropía: por eso basta SHA-256 (no hace falta un hash lento) para guardarlos.
 * El token en claro NUNCA se persiste, se registra ni se audita; solo viaja al destinatario.
 */
export const generateToken = (prefix: string): string => `${prefix}_${randomBytes(32).toString('base64url')}`;

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/** Formato esperado de un token, para descartar basura antes de consultar la base. */
export const looksLikeToken = (token: unknown, prefix: string): token is string =>
  typeof token === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9_-]{43}$`).test(token);
