import { ConsoleLogger, type INestApplication, ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppConfig } from './config/app-config.js';
import { requestIdMiddleware } from './common/utils/request-id.js';

export const API_PREFIX = 'v1';

export function createLogger(config: AppConfig) {
  return new ConsoleLogger({
    json: config.isProduction,
    colors: !config.isProduction,
    logLevels: config.isTest ? ['error', 'warn'] : ['log', 'warn', 'error'],
  });
}

/** Configuración común de la app (la usan main.ts y las pruebas e2e). */
export function configureApp(app: INestApplication, config: AppConfig): void {
  const express = app as NestExpressApplication;
  express.disable('x-powered-by');
  if (config.trustProxy > 0) express.set('trust proxy', config.trustProxy);

  app.use(requestIdMiddleware);
  app.use(
    helmet({
      // API JSON: sin recursos embebidos; HSTS lo fija Nginx en producción.
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  app.enableCors({
    origin: config.corsOrigins,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id'],
    maxAge: 600,
  });
  express.useBodyParser('json', { limit: '100kb' });
  app.setGlobalPrefix(API_PREFIX);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { exposeDefaultValues: true },
    }),
  );
  app.enableShutdownHooks();
}
