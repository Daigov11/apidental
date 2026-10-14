import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { CurrentPrincipal } from '../common/decorators/current-principal.decorator.js';
import { RequirePermissions } from '../common/decorators/permissions.decorator.js';
import { PaginationQuery } from '../common/dto/pagination.dto.js';
import { Meta, type RequestMeta } from '../common/utils/request-meta.js';
import { CreateBranchDto, ListBranchesQuery } from './dto/branch.dto.js';
import { CreateClinicDto } from './dto/clinic.dto.js';
import { TenancyService } from './tenancy.service.js';

@Controller()
export class TenancyController {
  constructor(private readonly tenancy: TenancyService) {}

  @Get('clinics')
  @RequirePermissions('clinic:read')
  listClinics(@CurrentPrincipal() principal: AuthPrincipal, @Query() q: PaginationQuery) {
    return this.tenancy.listClinics(principal, q.limit, q.offset);
  }

  @Post('clinics')
  @RequirePermissions('clinic:manage')
  createClinic(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body() dto: CreateClinicDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.tenancy.createClinic(principal, dto, meta);
  }

  @Get('branches')
  @RequirePermissions('branch:read')
  listBranches(@CurrentPrincipal() principal: AuthPrincipal, @Query() q: ListBranchesQuery) {
    return this.tenancy.listBranches(principal, q);
  }

  @Post('branches')
  @RequirePermissions('branch:manage')
  createBranch(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body() dto: CreateBranchDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.tenancy.createBranch(principal, dto, meta);
  }
}
