import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { AppConfig } from '../config/app-config.js';
import { CurrentPrincipal } from '../common/decorators/current-principal.decorator.js';
import { Public } from '../common/decorators/public.decorator.js';
import { Meta, type RequestMeta } from '../common/utils/request-meta.js';
import type { AppRequest, AuthPrincipal } from './auth.types.js';
import { AuthService } from './auth.service.js';
import { clearCookieOptions, parseCookies, refreshCookieOptions } from './cookies.js';
import { CookieCsrfGuard } from './csrf.guard.js';
import { LoginDto } from './dto/login.dto.js';
import { ReauthenticateDto } from './dto/reauth.dto.js';
import { SelectContextDto } from './dto/select-context.dto.js';
import { ReauthService } from './reauth.service.js';
import { RefreshRejectedException, SessionService } from './session.service.js';
import { TokenService } from './token.service.js';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly reauth: ReauthService,
    private readonly sessions: SessionService,
    private readonly tokens: TokenService,
    private readonly config: AppConfig,
  ) {}

  /**
   * Autentica. El access token (15 min) va en el cuerpo y se guarda SOLO en memoria del cliente.
   * El refresh token va SOLO en una cookie HttpOnly; jamás en el cuerpo. Aún no hay contexto activo.
   */
  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Meta() meta: RequestMeta, @Res({ passthrough: true }) res: Response) {
    const { body, refreshToken } = await this.auth.login(dto, meta);
    this.setRefreshCookie(res, refreshToken);
    this.noStore(res);
    return body;
  }

  /**
   * Renueva el access token con la cookie del refresh token, que rota en cada uso. Protegido contra
   * CSRF (ver CookieCsrfGuard). Cualquier fallo responde 401 y borra la cookie.
   */
  @Public()
  @UseGuards(CookieCsrfGuard)
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: AppRequest, @Meta() meta: RequestMeta, @Res({ passthrough: true }) res: Response) {
    const cookie = parseCookies(req.headers.cookie)[this.config.session.cookie.name];
    try {
      const { body, refreshToken } = await this.auth.refresh(cookie, meta);
      if (refreshToken) this.setRefreshCookie(res, refreshToken);
      this.noStore(res);
      return body;
    } catch (error) {
      if (error instanceof RefreshRejectedException) res.clearCookie(this.config.session.cookie.name, clearCookieOptions(this.config));
      throw error;
    }
  }

  /**
   * Cierra la sesión actual, identificada por el access token y/o por la cookie del refresh token
   * (sirve aunque el access token ya haya vencido). Idempotente; siempre 204 y siempre borra la cookie.
   */
  @Public()
  @UseGuards(CookieCsrfGuard)
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: AppRequest, @Meta() meta: RequestMeta, @Res({ passthrough: true }) res: Response) {
    const targets: { sessionId: string; userId: string }[] = [];
    const bearer = req.headers.authorization?.split(' ');
    if (bearer?.[0] === 'Bearer' && bearer[1]) {
      try {
        const payload = await this.tokens.verify(bearer[1]);
        targets.push({ sessionId: payload.sid, userId: payload.sub });
      } catch {
        // access token vencido o inválido: se usa la cookie
      }
    }
    const fromCookie = await this.sessions.sessionOfRefreshToken(parseCookies(req.headers.cookie)[this.config.session.cookie.name]);
    if (fromCookie && targets.every((t) => t.userId === fromCookie.userId)) targets.push(fromCookie);
    await this.auth.logout(targets, meta);
    res.clearCookie(this.config.session.cookie.name, clearCookieOptions(this.config));
    this.noStore(res);
  }

  /** Cierra TODAS las sesiones del usuario (incluida la actual) e invalida sus refresh tokens. */
  @UseGuards(CookieCsrfGuard)
  @Post('logout-all')
  @HttpCode(204)
  async logoutAll(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Meta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.auth.logoutAll(principal, meta);
    res.clearCookie(this.config.session.cookie.name, clearCookieOptions(this.config));
    this.noStore(res);
  }

  /**
   * Reautenticación: confirma la contraseña y emite una prueba corta (2 min), de un solo uso y
   * limitada a un propósito y un objeto. NO es una firma digital, legal ni clínica.
   */
  @Post('reauthenticate')
  @HttpCode(200)
  async reauthenticate(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body() dto: ReauthenticateDto,
    @Meta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.reauth.issue(principal, dto, meta);
    this.noStore(res);
    return result;
  }

  @Get('me')
  me(@CurrentPrincipal() principal: AuthPrincipal) {
    return this.auth.me(principal);
  }

  /** Clínicas/sedes/roles a los que el usuario puede acceder según sus asignaciones activas. */
  @Get('context')
  contexts(@CurrentPrincipal() principal: AuthPrincipal) {
    return this.auth.contexts(principal);
  }

  /** Valida el contexto contra UserAssignment y emite un token con contexto, de la MISMA sesión. */
  @Post('select-context')
  @HttpCode(200)
  selectContext(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body() dto: SelectContextDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.auth.selectContext(principal, dto, meta);
  }

  private setRefreshCookie(res: Response, token: string): void {
    res.cookie(this.config.session.cookie.name, token, refreshCookieOptions(this.config));
  }

  /** Las respuestas con credenciales nunca se cachean. */
  private noStore(res: Response): void {
    res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
  }
}
