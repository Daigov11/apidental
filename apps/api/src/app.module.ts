import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { Request } from 'express';
import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { JwtAuthGuard } from './auth/jwt-auth.guard.js';
import { PermissionsGuard } from './auth/permissions.guard.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { RequestLoggingInterceptor } from './common/interceptors/request-logging.interceptor.js';
import { AppConfig } from './config/app-config.js';
import { ConfigModule } from './config/config.module.js';
import { HealthModule } from './health/health.module.js';
import { PatientsModule } from './patients/patients.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { TenancyModule } from './tenancy/tenancy.module.js';
import { UsersModule } from './users/users.module.js';

const isLoginRoute = (req: Request): boolean => req.path.endsWith('/auth/login');

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    ThrottlerModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({
        // Límite general por IP, y uno más estricto solo para el login (fuerza bruta).
        throttlers: [
          {
            name: 'default',
            ttl: 60_000,
            limit: config.rateLimit.perMinute,
            skipIf: (ctx) => isLoginRoute(ctx.switchToHttp().getRequest<Request>()),
          },
          {
            name: 'login',
            ttl: 60_000,
            limit: config.rateLimit.loginPerMinute,
            skipIf: (ctx) => !isLoginRoute(ctx.switchToHttp().getRequest<Request>()),
          },
        ],
      }),
    }),
    AuthModule,
    AuditModule,
    HealthModule,
    TenancyModule,
    UsersModule,
    PatientsModule,
  ],
  providers: [
    // Orden de ejecución: límite de tasa → autenticación → permisos.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: RequestLoggingInterceptor },
  ],
})
export class AppModule {}
