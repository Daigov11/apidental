import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { CurrentPrincipal } from '../common/decorators/current-principal.decorator.js';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../common/decorators/permissions.decorator.js';
import { Meta, type RequestMeta } from '../common/utils/request-meta.js';
import { ClinicalAccessService } from './clinical-access.service.js';
import { ClinicalSummaryService } from './clinical-summary.service.js';
import { RequestClinicalAccessDto } from './dto/clinical.dto.js';

const uuid = () => new ParseUUIDPipe();

@Controller('patients/:id')
export class ClinicalController {
  constructor(
    private readonly summary: ClinicalSummaryService,
    private readonly access: ClinicalAccessService,
  ) {}

  /**
   * Resumen clínico. El permiso de ruta solo exige tener ALGÚN permiso clínico: la decisión real (relación
   * asistencial o autorización de lectura) y su auditoría las hace ClinicalAccessService.
   */
  @Get('clinical-summary')
  @RequireAnyPermission(
    'clinical:read',
    'clinical:read_limited',
    'clinical:read_all',
  )
  get(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Meta() meta: RequestMeta,
  ) {
    return this.summary.get(a, id, meta);
  }

  /** `clinical:read_all`: autorización de lectura de UN paciente por 30 minutos, con justificación y reautenticación. */
  @Post('clinical-access')
  @HttpCode(201)
  @RequirePermissions('clinical:read_all')
  request(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Body() dto: RequestClinicalAccessDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.access.requestReadAll(a, id, dto, meta);
  }
}
