import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { CurrentPrincipal } from '../common/decorators/current-principal.decorator.js';
import { Public } from '../common/decorators/public.decorator.js';
import { Meta, type RequestMeta } from '../common/utils/request-meta.js';
import type { AuthPrincipal } from './auth.types.js';
import { AuthService } from './auth.service.js';
import { LoginDto } from './dto/login.dto.js';
import { SelectContextDto } from './dto/select-context.dto.js';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Autentica y devuelve un token SIN contexto. Luego se elige clínica/sede con select-context. */
  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body() dto: LoginDto, @Meta() meta: RequestMeta) {
    return this.auth.login(dto, meta);
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

  /** Valida el contexto contra UserAssignment y emite un token ligado a él. */
  @Post('select-context')
  @HttpCode(200)
  selectContext(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body() dto: SelectContextDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.auth.selectContext(principal, dto, meta);
  }
}
