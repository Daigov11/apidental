import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  Logger,
  type NestInterceptor,
} from '@nestjs/common';
import type { Response } from 'express';
import { Observable, tap } from 'rxjs';
import type { AppRequest } from '../../auth/auth.types.js';

/**
 * Log estructurado de cada solicitud. Registra solo método, ruta (sin query string),
 * estado, duración, usuario y requestId. Nunca cuerpos, cabeceras ni tokens.
 */
@Injectable()
export class RequestLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<AppRequest>();
    const res = http.getResponse<Response>();
    const started = Date.now();

    const log = (status: number) =>
      this.logger.log({
        msg: 'request',
        requestId: req.requestId,
        method: req.method,
        path: req.path,
        status,
        durationMs: Date.now() - started,
        userId: req.principal?.user.id,
        clinicId: req.principal?.context?.clinicId ?? undefined,
      });

    return next.handle().pipe(
      tap({
        next: () => log(res.statusCode),
        error: (err: { status?: number }) => log(typeof err?.status === 'number' ? err.status : 500),
      }),
    );
  }
}
