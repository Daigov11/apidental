import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AppRequest } from '../../auth/auth.types.js';

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

export function requestMetaFrom(req: AppRequest): RequestMeta {
  const ua = req.headers['user-agent'];
  return {
    ip: req.ip ? req.ip.slice(0, 64) : null,
    userAgent: typeof ua === 'string' ? ua.slice(0, 255) : null,
  };
}

/** IP y user agent de la solicitud, para auditoría. */
export const Meta = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): RequestMeta =>
    requestMetaFrom(ctx.switchToHttp().getRequest<AppRequest>()),
);
