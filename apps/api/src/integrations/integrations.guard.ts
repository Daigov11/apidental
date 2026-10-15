import { type CanActivate, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { AppConfig } from '../config/app-config.js';

/** Las rutas de cobros, comprobantes, fidelización y reseñas solo existen con INTEGRATIONS_MODE=mock. */
@Injectable()
export class IntegrationsEnabledGuard implements CanActivate {
  constructor(private readonly config: AppConfig) {}
  canActivate(): boolean {
    if (this.config.integrations.mode !== 'mock') {
      throw new HttpException({ message: 'Las integraciones no están activadas en este entorno', code: 'INTEGRATIONS_DISABLED' }, HttpStatus.SERVICE_UNAVAILABLE);
    }
    return true;
  }
}
