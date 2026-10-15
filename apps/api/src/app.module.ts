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
import { CryptoModule } from './common/crypto/crypto.module.js';
import { ClinicalModule } from './clinical/clinical.module.js';
import { AppConfig } from './config/app-config.js';
import { ConfigModule } from './config/config.module.js';
import { DeliveryModule } from './invitations/delivery/delivery.module.js';
import { InvitationsModule } from './invitations/invitations.module.js';
import { HealthModule } from './health/health.module.js';
import { MaintenanceModule } from './maintenance/maintenance.module.js';
import { PatientsModule } from './patients/patients.module.js';
import { ProvisioningModule } from './provisioning/provisioning.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { TenancyModule } from './tenancy/tenancy.module.js';
import { UsersModule } from './users/users.module.js';

/** Rutas públicas o de verificación de contraseña/token: comparten el límite estricto por IP (fuerza bruta). */
const STRICT_ROUTES = [
  '/auth/login',
  '/auth/reauthenticate',
  '/auth/password-recovery',
  '/auth/password-recovery/validate',
  '/auth/password-recovery/confirm',
  '/invitations/accept',
  '/invitations/preview',
];
const isLoginRoute = (req: Request): boolean => STRICT_ROUTES.some((r) => req.path.endsWith(r));

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    CryptoModule,
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
    DeliveryModule,
    HealthModule,
    TenancyModule,
    UsersModule,
    PatientsModule,
    ClinicalModule,
    ProvisioningModule,
    InvitationsModule,
    MaintenanceModule,
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
