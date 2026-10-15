import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator.js';
import { Meta, type RequestMeta } from '../common/utils/request-meta.js';
import {
  ConfirmPasswordRecoveryDto,
  RequestPasswordRecoveryDto,
  ValidateRecoveryTokenDto,
} from './dto/password-recovery.dto.js';
import { PasswordRecoveryService } from './password-recovery.service.js';

/** Todas públicas (la persona no puede iniciar sesión) y con el límite estricto por IP del login. */
@Controller('auth/password-recovery')
export class PasswordRecoveryController {
  constructor(private readonly recovery: PasswordRecoveryService) {}

  /**
   * Solicita instrucciones. SIEMPRE responde lo mismo (202) y de inmediato, exista o no la cuenta:
   * el enlace va solo al correo por el canal configurado y jamás en esta respuesta.
   */
  @Public()
  @Post()
  @HttpCode(202)
  request(@Body() dto: RequestPasswordRecoveryDto, @Meta() meta: RequestMeta) {
    return this.recovery.request(dto.email, meta);
  }

  /** ¿Sigue vigente el enlace? Sirve para avisar antes de pedir la contraseña nueva. */
  @Public()
  @Post('validate')
  @HttpCode(200)
  validate(@Body() dto: ValidateRecoveryTokenDto) {
    return this.recovery.validate(dto.token);
  }

  /** Fija la contraseña nueva y cierra TODAS las sesiones del usuario. No inicia sesión. */
  @Public()
  @Post('confirm')
  @HttpCode(200)
  confirm(@Body() dto: ConfirmPasswordRecoveryDto, @Meta() meta: RequestMeta) {
    return this.recovery.confirm(dto, meta);
  }
}
