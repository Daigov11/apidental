import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { CurrentPrincipal } from '../common/decorators/current-principal.decorator.js';
import { RequireAnyPermission } from '../common/decorators/permissions.decorator.js';
import { Meta, type RequestMeta } from '../common/utils/request-meta.js';
import { ClinicalAlertsService } from './clinical-alerts.service.js';
import { ClinicalHistoryService } from './clinical-history.service.js';
import { CLINICAL_OPTIONS } from './clinical-options.js';
import {
  ChangeAlertDto,
  ChangeHistoryEntryDto,
  CreateAlertDto,
  CreateHistoryEntryDto,
  ListAlertsQuery,
  ListHistoryQuery,
  TransitionDto,
} from './dto/history.dto.js';

const uuid = () => new ParseUUIDPipe();
// El permiso de ruta solo exige tener ALGÚN permiso clínico; la decisión real y su auditoría las toma ClinicalAccessService.
const ANY_CLINICAL = [
  'clinical:read',
  'clinical:read_limited',
  'clinical:read_all',
] as const;
const WRITE = ['clinical:write'] as const;

@Controller()
export class ClinicalHistoryController {
  constructor(
    private readonly history: ClinicalHistoryService,
    private readonly alerts: ClinicalAlertsService,
  ) {}

  /** Valores sugeridos de apoyo administrativo (no clínicos, no dependen del paciente). */
  @Get('clinical/options')
  @RequireAnyPermission(...ANY_CLINICAL)
  options() {
    return CLINICAL_OPTIONS;
  }

  // ------------------------------------------------------- antecedentes y alergias

  @Get('patients/:id/clinical/history')
  @RequireAnyPermission(...ANY_CLINICAL)
  list(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Query() q: ListHistoryQuery,
    @Meta() meta: RequestMeta,
  ) {
    return this.history.list(a, id, q, meta);
  }

  @Post('patients/:id/clinical/history')
  @RequireAnyPermission(...WRITE)
  create(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Body() dto: CreateHistoryEntryDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.history.create(a, id, dto, meta);
  }

  @Get('patients/:id/clinical/history/:itemId')
  @RequireAnyPermission(...ANY_CLINICAL)
  get(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Param('itemId', uuid()) itemId: string,
    @Meta() meta: RequestMeta,
  ) {
    return this.history.get(a, id, itemId, meta);
  }

  @Get('patients/:id/clinical/history/:itemId/versions')
  @RequireAnyPermission(...ANY_CLINICAL)
  versions(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Param('itemId', uuid()) itemId: string,
    @Meta() meta: RequestMeta,
  ) {
    return this.history.versions(a, id, itemId, meta);
  }

  @Post('patients/:id/clinical/history/:itemId/correct')
  @HttpCode(200)
  @RequireAnyPermission(...WRITE)
  correct(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Param('itemId', uuid()) itemId: string,
    @Body() dto: ChangeHistoryEntryDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.history.change(a, id, itemId, dto, 'CORRECTED', meta);
  }

  @Post('patients/:id/clinical/history/:itemId/rectify')
  @HttpCode(200)
  @RequireAnyPermission(...WRITE)
  rectify(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Param('itemId', uuid()) itemId: string,
    @Body() dto: ChangeHistoryEntryDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.history.change(a, id, itemId, dto, 'RECTIFIED', meta);
  }

  @Post('patients/:id/clinical/history/:itemId/deactivate')
  @HttpCode(200)
  @RequireAnyPermission(...WRITE)
  deactivate(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Param('itemId', uuid()) itemId: string,
    @Body() dto: TransitionDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.history.transition(
      a,
      id,
      itemId,
      dto.expectedVersion,
      dto.reason,
      'DEACTIVATED',
      meta,
    );
  }

  @Post('patients/:id/clinical/history/:itemId/reactivate')
  @HttpCode(200)
  @RequireAnyPermission(...WRITE)
  reactivate(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Param('itemId', uuid()) itemId: string,
    @Body() dto: TransitionDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.history.transition(
      a,
      id,
      itemId,
      dto.expectedVersion,
      dto.reason,
      'REACTIVATED',
      meta,
    );
  }

  @Post('patients/:id/clinical/history/:itemId/mark-error')
  @HttpCode(200)
  @RequireAnyPermission(...WRITE)
  markError(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Param('itemId', uuid()) itemId: string,
    @Body() dto: TransitionDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.history.transition(
      a,
      id,
      itemId,
      dto.expectedVersion,
      dto.reason,
      'MARKED_IN_ERROR',
      meta,
    );
  }

  // ------------------------------------------------------------------ alertas

  @Get('patients/:id/clinical/alerts')
  @RequireAnyPermission(...ANY_CLINICAL)
  listAlerts(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Query() q: ListAlertsQuery,
    @Meta() meta: RequestMeta,
  ) {
    return this.alerts.list(a, id, q, meta);
  }

  @Post('patients/:id/clinical/alerts')
  @RequireAnyPermission(...WRITE)
  createAlert(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Body() dto: CreateAlertDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.alerts.create(a, id, dto, meta);
  }

  @Get('patients/:id/clinical/alerts/:itemId/versions')
  @RequireAnyPermission(...ANY_CLINICAL)
  alertVersions(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Param('itemId', uuid()) itemId: string,
    @Meta() meta: RequestMeta,
  ) {
    return this.alerts.versions(a, id, itemId, meta);
  }

  @Post('patients/:id/clinical/alerts/:itemId/correct')
  @HttpCode(200)
  @RequireAnyPermission(...WRITE)
  correctAlert(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Param('itemId', uuid()) itemId: string,
    @Body() dto: ChangeAlertDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.alerts.change(a, id, itemId, dto, meta);
  }

  @Post('patients/:id/clinical/alerts/:itemId/deactivate')
  @HttpCode(200)
  @RequireAnyPermission(...WRITE)
  deactivateAlert(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Param('itemId', uuid()) itemId: string,
    @Body() dto: TransitionDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.alerts.transition(
      a,
      id,
      itemId,
      dto.expectedVersion,
      dto.reason,
      'DEACTIVATED',
      meta,
    );
  }

  @Post('patients/:id/clinical/alerts/:itemId/reactivate')
  @HttpCode(200)
  @RequireAnyPermission(...WRITE)
  reactivateAlert(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Param('itemId', uuid()) itemId: string,
    @Body() dto: TransitionDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.alerts.transition(
      a,
      id,
      itemId,
      dto.expectedVersion,
      dto.reason,
      'REACTIVATED',
      meta,
    );
  }

  @Post('patients/:id/clinical/alerts/:itemId/mark-error')
  @HttpCode(200)
  @RequireAnyPermission(...WRITE)
  markAlertError(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Param('itemId', uuid()) itemId: string,
    @Body() dto: TransitionDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.alerts.transition(
      a,
      id,
      itemId,
      dto.expectedVersion,
      dto.reason,
      'MARKED_IN_ERROR',
      meta,
    );
  }
}
