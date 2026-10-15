import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { CurrentPrincipal } from '../common/decorators/current-principal.decorator.js';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../common/decorators/permissions.decorator.js';
import { Meta, type RequestMeta } from '../common/utils/request-meta.js';
import { ClinicalDiagnosesService } from './clinical-diagnoses.service.js';
import { ClinicalProceduresService } from './clinical-procedures.service.js';
import { ClinicalVisitsService } from './clinical-visits.service.js';
import {
  CancelVisitDto,
  ChangeDiagnosisDto,
  ChangeProcedureDto,
  CloseProcedureDto,
  CreateDiagnosisDto,
  CreateProcedureDefinitionDto,
  CreateProcedureDto,
  DefinitionTransitionDto,
  ListDefinitionsQuery,
  ListDiagnosesQuery,
  ListProceduresQuery,
  ListVisitsQuery,
  OpenVisitDto,
  ProcedureTransitionDto,
  UpdateProcedureDefinitionDto,
  VisitTransitionDto,
} from './dto/care.dto.js';
import { ProcedureDefinitionsService } from './procedure-definitions.service.js';

const uuid = () => new ParseUUIDPipe();
// El permiso de ruta solo exige tener ALGÚN permiso clínico; la decisión real y su auditoría las toma ClinicalAccessService.
const ANY_CLINICAL = [
  'clinical:read',
  'clinical:read_limited',
  'clinical:read_all',
] as const;
const P = 'patients/:id/clinical';

@Controller()
export class ClinicalCareController {
  constructor(
    private readonly definitions: ProcedureDefinitionsService,
    private readonly visits: ClinicalVisitsService,
    private readonly diagnoses: ClinicalDiagnosesService,
    private readonly procedures: ClinicalProceduresService,
  ) {}

  // ------------------------------------------------------------- catálogo (configuración de la clínica)

  @Get('procedure-definitions')
  @RequirePermissions('procedure:read')
  listDefinitions(
    @CurrentPrincipal() a: AuthPrincipal,
    @Query() q: ListDefinitionsQuery,
  ) {
    return this.definitions.list(a, q);
  }

  @Post('procedure-definitions')
  @RequirePermissions('procedure:manage')
  createDefinition(
    @CurrentPrincipal() a: AuthPrincipal,
    @Body() dto: CreateProcedureDefinitionDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.definitions.create(a, dto, meta);
  }

  @Patch('procedure-definitions/:defId')
  @RequirePermissions('procedure:manage')
  updateDefinition(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('defId', uuid()) id: string,
    @Body() dto: UpdateProcedureDefinitionDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.definitions.update(a, id, dto, meta);
  }

  @Post('procedure-definitions/:defId/deactivate')
  @HttpCode(200)
  @RequirePermissions('procedure:manage')
  deactivateDefinition(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('defId', uuid()) id: string,
    @Body() dto: DefinitionTransitionDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.definitions.setStatus(
      a,
      id,
      'INACTIVE',
      dto.expectedVersion,
      dto.reason,
      meta,
    );
  }

  @Post('procedure-definitions/:defId/reactivate')
  @HttpCode(200)
  @RequirePermissions('procedure:manage')
  reactivateDefinition(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('defId', uuid()) id: string,
    @Body() dto: DefinitionTransitionDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.definitions.setStatus(
      a,
      id,
      'ACTIVE',
      dto.expectedVersion,
      dto.reason,
      meta,
    );
  }

  // ----------------------------------------------------------------------------------------------- visitas

  @Post(`${P}/visits`)
  @RequirePermissions('clinical:write')
  openVisit(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Body() dto: OpenVisitDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.visits.open(a, id, dto, meta);
  }

  @Get(`${P}/visits`)
  @RequireAnyPermission(...ANY_CLINICAL)
  listVisits(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Query() q: ListVisitsQuery,
    @Meta() meta: RequestMeta,
  ) {
    return this.visits.list(a, id, q, meta);
  }

  @Get(`${P}/visits/:visitId`)
  @RequireAnyPermission(...ANY_CLINICAL)
  getVisit(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Param('visitId', uuid()) visitId: string,
    @Meta() meta: RequestMeta,
  ) {
    return this.visits.get(a, id, visitId, meta);
  }

  @Post(`${P}/visits/:visitId/close`)
  @HttpCode(200)
  @RequirePermissions('clinical:write')
  closeVisit(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Param('visitId', uuid()) visitId: string,
    @Body() dto: VisitTransitionDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.visits.close(a, id, visitId, dto, meta);
  }

  @Post(`${P}/visits/:visitId/cancel`)
  @HttpCode(200)
  @RequirePermissions('clinical:write')
  cancelVisit(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Param('visitId', uuid()) visitId: string,
    @Body() dto: CancelVisitDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.visits.cancel(a, id, visitId, dto, meta);
  }

  // ------------------------------------------------------------------------------------------ diagnósticos

  @Post(`${P}/visits/:visitId/diagnoses`)
  @RequirePermissions('clinical:write')
  createDiagnosis(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Param('visitId', uuid()) visitId: string,
    @Body() dto: CreateDiagnosisDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.diagnoses.create(a, id, visitId, dto, meta);
  }

  @Get(`${P}/diagnoses`)
  @RequireAnyPermission(...ANY_CLINICAL)
  listDiagnoses(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Query() q: ListDiagnosesQuery,
    @Meta() meta: RequestMeta,
  ) {
    return this.diagnoses.list(a, id, q, meta);
  }

  @Get(`${P}/diagnoses/:itemId`)
  @RequireAnyPermission(...ANY_CLINICAL)
  getDiagnosis(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Param('itemId', uuid()) itemId: string,
    @Meta() meta: RequestMeta,
  ) {
    return this.diagnoses.get(a, id, itemId, meta);
  }

  @Get(`${P}/diagnoses/:itemId/versions`)
  @RequireAnyPermission(...ANY_CLINICAL)
  diagnosisVersions(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Param('itemId', uuid()) itemId: string,
    @Meta() meta: RequestMeta,
  ) {
    return this.diagnoses.versions(a, id, itemId, meta);
  }

  @Post(`${P}/diagnoses/:itemId/correct`)
  @HttpCode(200)
  @RequirePermissions('clinical:write')
  correctDiagnosis(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Param('itemId', uuid()) itemId: string,
    @Body() dto: ChangeDiagnosisDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.diagnoses.change(a, id, itemId, dto, 'CORRECTED', meta);
  }

  @Post(`${P}/diagnoses/:itemId/rectify`)
  @HttpCode(200)
  @RequirePermissions('clinical:write')
  rectifyDiagnosis(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Param('itemId', uuid()) itemId: string,
    @Body() dto: ChangeDiagnosisDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.diagnoses.change(a, id, itemId, dto, 'RECTIFIED', meta);
  }

  @Post(`${P}/diagnoses/:itemId/deactivate`)
  @HttpCode(200)
  @RequirePermissions('clinical:write')
  deactivateDiagnosis(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Param('itemId', uuid()) itemId: string,
    @Body() dto: ProcedureTransitionDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.diagnoses.transition(
      a,
      id,
      itemId,
      dto.expectedVersion,
      dto.reason,
      'DEACTIVATED',
      meta,
    );
  }

  @Post(`${P}/diagnoses/:itemId/reactivate`)
  @HttpCode(200)
  @RequirePermissions('clinical:write')
  reactivateDiagnosis(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Param('itemId', uuid()) itemId: string,
    @Body() dto: ProcedureTransitionDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.diagnoses.transition(
      a,
      id,
      itemId,
      dto.expectedVersion,
      dto.reason,
      'REACTIVATED',
      meta,
    );
  }

  @Post(`${P}/diagnoses/:itemId/mark-error`)
  @HttpCode(200)
  @RequirePermissions('clinical:write')
  markDiagnosisError(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Param('itemId', uuid()) itemId: string,
    @Body() dto: ProcedureTransitionDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.diagnoses.transition(
      a,
      id,
      itemId,
      dto.expectedVersion,
      dto.reason,
      'MARKED_IN_ERROR',
      meta,
    );
  }

  // ---------------------------------------------------------------------------------------- procedimientos

  @Post(`${P}/visits/:visitId/procedures`)
  @RequirePermissions('clinical:write')
  createProcedure(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Param('visitId', uuid()) visitId: string,
    @Body() dto: CreateProcedureDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.procedures.create(a, id, visitId, dto, meta);
  }

  @Get(`${P}/procedures`)
  @RequireAnyPermission(...ANY_CLINICAL)
  listProcedures(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Query() q: ListProceduresQuery,
    @Meta() meta: RequestMeta,
  ) {
    return this.procedures.list(a, id, q, meta);
  }

  @Get(`${P}/procedures/:itemId`)
  @RequireAnyPermission(...ANY_CLINICAL)
  getProcedure(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Param('itemId', uuid()) itemId: string,
    @Meta() meta: RequestMeta,
  ) {
    return this.procedures.get(a, id, itemId, meta);
  }

  @Get(`${P}/procedures/:itemId/versions`)
  @RequireAnyPermission(...ANY_CLINICAL)
  procedureVersions(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Param('itemId', uuid()) itemId: string,
    @Meta() meta: RequestMeta,
  ) {
    return this.procedures.versions(a, id, itemId, meta);
  }

  @Post(`${P}/procedures/:itemId/correct`)
  @HttpCode(200)
  @RequirePermissions('clinical:write')
  correctProcedure(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Param('itemId', uuid()) itemId: string,
    @Body() dto: ChangeProcedureDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.procedures.change(a, id, itemId, dto, 'CORRECTED', meta);
  }

  @Post(`${P}/procedures/:itemId/rectify`)
  @HttpCode(200)
  @RequirePermissions('clinical:write')
  rectifyProcedure(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Param('itemId', uuid()) itemId: string,
    @Body() dto: ChangeProcedureDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.procedures.change(a, id, itemId, dto, 'RECTIFIED', meta);
  }

  @Post(`${P}/procedures/:itemId/close`)
  @HttpCode(200)
  @RequirePermissions('clinical:write')
  closeProcedure(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Param('itemId', uuid()) itemId: string,
    @Body() dto: CloseProcedureDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.procedures.close(a, id, itemId, dto.expectedVersion, meta);
  }

  @Post(`${P}/procedures/:itemId/cancel`)
  @HttpCode(200)
  @RequirePermissions('clinical:write')
  cancelProcedure(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Param('itemId', uuid()) itemId: string,
    @Body() dto: ProcedureTransitionDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.procedures.cancel(
      a,
      id,
      itemId,
      dto.expectedVersion,
      dto.reason,
      meta,
    );
  }

  @Post(`${P}/procedures/:itemId/mark-error`)
  @HttpCode(200)
  @RequirePermissions('clinical:write')
  markProcedureError(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Param('itemId', uuid()) itemId: string,
    @Body() dto: ProcedureTransitionDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.procedures.markError(
      a,
      id,
      itemId,
      dto.expectedVersion,
      dto.reason,
      meta,
    );
  }
}
