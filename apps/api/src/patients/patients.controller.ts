import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { CurrentPrincipal } from '../common/decorators/current-principal.decorator.js';
import { RequirePermissions } from '../common/decorators/permissions.decorator.js';
import { Meta, type RequestMeta } from '../common/utils/request-meta.js';
import {
  ChangeContactDto,
  ContactInput,
  CreatePatientDto,
  DuplicateCheckDto,
  RetireContactDto,
  SearchPatientsQuery,
  SetIdentifierDto,
  StatusChangeDto,
  UpdatePatientDto,
} from './dto/patient.dto.js';
import { PatientsService } from './patients.service.js';

const uuid = () => new ParseUUIDPipe();

/** Todas las rutas operan dentro de la clínica del contexto activo (el clinicId nunca viene del cliente). */
@Controller('patients')
export class PatientsController {
  constructor(private readonly patients: PatientsService) {}

  // --- rutas estáticas primero: si no, ":id" las capturaría ---

  @Post()
  @RequirePermissions('patient:write')
  create(@CurrentPrincipal() a: AuthPrincipal, @Body() dto: CreatePatientDto, @Meta() meta: RequestMeta) {
    return this.patients.create(a, dto, meta);
  }

  @Post('duplicate-check')
  @HttpCode(200)
  @RequirePermissions('patient:write')
  check(@CurrentPrincipal() a: AuthPrincipal, @Body() dto: DuplicateCheckDto, @Meta() meta: RequestMeta) {
    return this.patients.checkDuplicates(a, dto, meta);
  }

  @Get('duplicate-report')
  @RequirePermissions('patient:read')
  report(@CurrentPrincipal() a: AuthPrincipal, @Meta() meta: RequestMeta) {
    return this.patients.duplicateReport(a, meta);
  }

  @Get()
  @RequirePermissions('patient:read_basic')
  search(@CurrentPrincipal() a: AuthPrincipal, @Query() q: SearchPatientsQuery, @Meta() meta: RequestMeta) {
    return this.patients.search(a, q, meta);
  }

  @Get(':id')
  @RequirePermissions('patient:read_basic')
  get(@CurrentPrincipal() a: AuthPrincipal, @Param('id', uuid()) id: string, @Meta() meta: RequestMeta) {
    return this.patients.get(a, id, meta);
  }

  @Patch(':id')
  @RequirePermissions('patient:write')
  update(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Body() dto: UpdatePatientDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.patients.update(a, id, dto, meta);
  }

  @Post(':id/deactivate')
  @HttpCode(200)
  @RequirePermissions('patient:write')
  deactivate(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Body() dto: StatusChangeDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.patients.setStatus(a, id, 'INACTIVE', dto.reason, meta);
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  @RequirePermissions('patient:write')
  reactivate(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Body() dto: StatusChangeDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.patients.setStatus(a, id, 'ACTIVE', dto.reason, meta);
  }

  @Get(':id/duplicates')
  @RequirePermissions('patient:read')
  duplicates(@CurrentPrincipal() a: AuthPrincipal, @Param('id', uuid()) id: string, @Meta() meta: RequestMeta) {
    return this.patients.duplicatesOf(a, id, meta);
  }

  @Put(':id/identifiers')
  @RequirePermissions('patient:write')
  setIdentifier(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Body() dto: SetIdentifierDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.patients.setIdentifier(a, id, dto, meta);
  }

  @Post(':id/contacts')
  @RequirePermissions('patient:write')
  addContact(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Body() dto: ContactInput,
    @Meta() meta: RequestMeta,
  ) {
    return this.patients.addContact(a, id, dto, meta);
  }

  @Patch(':id/contacts/:contactId')
  @RequirePermissions('patient:write')
  changeContact(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Param('contactId', uuid()) contactId: string,
    @Body() dto: ChangeContactDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.patients.changeContact(a, id, contactId, dto, meta);
  }

  @Post(':id/contacts/:contactId/retire')
  @HttpCode(200)
  @RequirePermissions('patient:write')
  retireContact(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Param('contactId', uuid()) contactId: string,
    @Body() dto: RetireContactDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.patients.retireContact(a, id, contactId, dto, meta);
  }
}
