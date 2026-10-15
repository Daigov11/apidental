import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AccessService } from './access.service.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { CookieCsrfGuard } from './csrf.guard.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { LoginAttemptsService } from './login-attempts.service.js';
import { PermissionsGuard } from './permissions.guard.js';
import { ReauthService } from './reauth.service.js';
import { SessionService } from './session.service.js';
import { TokenService } from './token.service.js';

@Global()
@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [
    AuthService,
    AccessService,
    TokenService,
    SessionService,
    ReauthService,
    LoginAttemptsService,
    CookieCsrfGuard,
    JwtAuthGuard,
    PermissionsGuard,
  ],
  exports: [AccessService, TokenService, SessionService, ReauthService, LoginAttemptsService, JwtAuthGuard, PermissionsGuard],
})
export class AuthModule {}
