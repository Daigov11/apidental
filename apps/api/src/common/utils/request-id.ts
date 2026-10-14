import { randomUUID } from 'node:crypto';
import type { NextFunction, Response } from 'express';
import type { AppRequest } from '../../auth/auth.types.js';

const VALID_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** Asigna un id de correlación (acepta el de un proxy si es seguro) y lo devuelve en la cabecera. */
export function requestIdMiddleware(req: AppRequest, res: Response, next: NextFunction): void {
  const incoming = req.headers['x-request-id'];
  req.requestId = typeof incoming === 'string' && VALID_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
}
