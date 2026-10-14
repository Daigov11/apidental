import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import type { AppRequest } from '../../auth/auth.types.js';

const STATUS_LABEL: Record<number, string> = {
  400: 'Solicitud inválida',
  401: 'No autenticado',
  403: 'Acceso denegado',
  404: 'No encontrado',
  409: 'Conflicto',
  422: 'Datos no procesables',
  429: 'Demasiadas solicitudes',
  503: 'Servicio no disponible',
};

/** Respuesta de error uniforme. Nunca expone trazas ni mensajes internos en errores 5xx. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Errors');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<AppRequest>();

    let statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = 'Error interno del servidor';
    let extra: Record<string, unknown> = {};

    if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
      } else if (body && typeof body === 'object') {
        const { message: m, error: _e, statusCode: _s, ...rest } = body as Record<string, unknown>;
        if (typeof m === 'string' || Array.isArray(m)) message = m as string | string[];
        else message = exception.message;
        extra = rest;
      }
    }

    if (statusCode >= 500) {
      this.logger.error({
        msg: 'Error no controlado',
        requestId: req.requestId,
        path: req.path,
        error: exception instanceof Error ? `${exception.name}: ${exception.message}` : 'desconocido',
        stack: exception instanceof Error ? exception.stack : undefined,
      });
    }

    res.status(statusCode).json({
      statusCode,
      error: STATUS_LABEL[statusCode] ?? 'Error',
      message,
      ...extra,
      path: req.path,
      requestId: req.requestId,
      timestamp: new Date().toISOString(),
    });
  }
}
