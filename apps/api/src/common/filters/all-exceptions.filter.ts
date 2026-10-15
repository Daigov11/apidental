import {
  type ArgumentsHost,
  Inject,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuditAction, AuditService } from '../../audit/audit.service.js';
import type { AppRequest } from '../../auth/auth.types.js';
import { ClinicalAccessDeniedException } from '../../clinical/clinical.errors.js';
import { requestMetaFrom } from '../utils/request-meta.js';

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
  /** Evita inundar la auditoría: una misma negativa (usuario + ruta + motivo) se registra como máximo una vez por minuto. */
  private readonly recentDenials = new Map<string, number>();
  private static readonly DENIAL_WINDOW_MS = 60_000;

  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  /**
   * Auditoría de accesos denegados (403) de usuarios AUTENTICADOS: permisos clínicos/administrativos, contexto
   * inválido, alcance. Solo se guarda quién, desde dónde, qué ruta (el PATRÓN, sin ids ni consulta) y por qué:
   * nunca cuerpos, parámetros, secretos ni datos clínicos.
   */
  private async auditDenial(req: AppRequest): Promise<void> {
    const principal = req.principal;
    if (!principal) return; // sin identidad (p. ej. CSRF): nada que atribuir
    const route = typeof req.route?.path === 'string' ? req.route.path : '(sin ruta)';
    const reason = req.denial?.reason ?? 'forbidden';
    const key = `${principal.user.id}|${req.method}|${route}|${reason}`;
    const now = Date.now();
    const last = this.recentDenials.get(key);
    if (last !== undefined && now - last < AllExceptionsFilter.DENIAL_WINDOW_MS) return;
    if (this.recentDenials.size > 5_000) {
      for (const [k, t] of this.recentDenials) if (now - t >= AllExceptionsFilter.DENIAL_WINDOW_MS) this.recentDenials.delete(k);
    }
    this.recentDenials.set(key, now);
    await this.audit.recordSafely({
      action: AuditAction.AccessDenied,
      entity: 'Request',
      userId: principal.user.id,
      clinicId: principal.context?.clinicId ?? null,
      branchId: principal.context?.branchId ?? null,
      meta: requestMetaFrom(req),
      summary: { method: req.method, route, reason, requiredPermissions: req.denial?.required ?? [] },
    });
  }

  async catch(exception: unknown, host: ArgumentsHost): Promise<void> {
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

    // Las negativas clínicas ya se auditaron con paciente y motivo (CLINICAL_ACCESS_DENIED).
    if (statusCode === 403 && !(exception instanceof ClinicalAccessDeniedException)) await this.auditDenial(req);

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
