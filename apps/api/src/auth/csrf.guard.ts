import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { AppConfig } from '../config/app-config.js';
import type { AppRequest } from './auth.types.js';

export const CSRF_HEADER = 'x-requested-with';
export const CSRF_HEADER_VALUE = 'ApiDental';

/**
 * Protección CSRF de los endpoints que usan la cookie del refresh token (refresh, logout).
 * El resto de la API se autentica con `Authorization: Bearer`, que el navegador no envía solo,
 * por lo que no es vulnerable a CSRF. Para la cookie se aplican CUATRO barreras independientes:
 *
 *  1. SameSite=Strict en la cookie: un sitio externo no consigue que el navegador la adjunte.
 *  2. `Origin` obligatorio y dentro de la lista permitida (CORS_ORIGINS). Los navegadores siempre lo
 *     envían en POST y un atacante no puede falsearlo.
 *  3. Cabecera personalizada `X-Requested-With: ApiDental`: obliga a una solicitud "no simple" que
 *     el navegador solo permite entre orígenes si CORS lo autoriza.
 *  4. `Content-Type: application/json` (también "no simple") y `Sec-Fetch-Site` distinto de `cross-site`.
 *
 * CORS permite `credentials` únicamente para los orígenes configurados.
 */
@Injectable()
export class CookieCsrfGuard implements CanActivate {
  constructor(private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AppRequest>();
    const deny = (): never => {
      throw new ForbiddenException('Solicitud rechazada por la protección CSRF');
    };
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || !this.config.corsOrigins.includes(origin)) deny();
    if (req.headers[CSRF_HEADER] !== CSRF_HEADER_VALUE) deny();
    if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) deny();
    if (req.headers['sec-fetch-site'] === 'cross-site') deny();
    return true;
  }
}
