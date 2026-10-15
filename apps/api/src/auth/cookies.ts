import type { CookieOptions } from 'express';
import type { AppConfig } from '../config/app-config.js';

/** Parser mínimo de la cabecera Cookie (evita una dependencia solo para esto). */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    const raw = part.slice(i + 1).trim();
    if (!name || name in out) continue; // la primera ocurrencia manda
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      out[name] = raw;
    }
  }
  return out;
}

/**
 * Cookie del refresh token. Diseño para dental.apiworking.com.pe (panel) y
 * api.dental.apiworking.com.pe (API):
 *  - HttpOnly: el JavaScript del panel nunca ve el token.
 *  - Secure + prefijo __Host- (producción): solo HTTPS, Path=/ y SIN atributo Domain, es decir
 *    "host-only": solo la envía el navegador al host que la emitió (la API) y ningún subdominio
 *    hermano puede sobrescribirla (cookie tossing).
 *  - SameSite=Strict: ambos hosts son "same-site" (mismo sitio registrable), así que el panel puede
 *    llamar a la API con credenciales, pero ningún otro sitio puede hacer que el navegador la envíe.
 */
export function refreshCookieOptions(config: AppConfig): CookieOptions {
  return {
    httpOnly: true,
    secure: config.session.cookie.secure,
    sameSite: 'strict',
    path: '/',
    maxAge: config.session.refreshTtlSeconds * 1000,
  };
}

/** Para borrar la cookie hay que repetir los mismos atributos de identidad (sin maxAge). */
export function clearCookieOptions(config: AppConfig): CookieOptions {
  const { maxAge: _maxAge, ...rest } = refreshCookieOptions(config);
  return rest;
}
