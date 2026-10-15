import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res, StreamableFile, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { CurrentPrincipal } from '../common/decorators/current-principal.decorator.js';
import { RequireAnyPermission, RequirePermissions } from '../common/decorators/permissions.decorator.js';
import { Meta, type RequestMeta } from '../common/utils/request-meta.js';
import { AppConfig } from '../config/app-config.js';
import { BillingService } from './billing.service.js';
import { ChargesService } from './charges.service.js';
import { CreateChargeDto, EmitDocumentDto, ListChargesQuery, ListDocumentsQuery, ListOutboxQuery, PayChargeDto, RedeemDto, VoidChargeDto } from './dto/integrations.dto.js';
import { IntegrationsEnabledGuard } from './integrations.guard.js';
import { LoyaltyService } from './loyalty.service.js';

const uuid = () => new ParseUUIDPipe();

/** Estado de las integraciones: el panel decide con esto qué módulos mostrar y que debe avisar «simulación». */
@Controller('integrations')
export class IntegrationsStatusController {
  constructor(private readonly config: AppConfig, private readonly billing: BillingService) {}

  @Get('status')
  @RequireAnyPermission('appointment:read', 'charge:read', 'billing:read', 'loyalty:read')
  status() {
    return this.billing.status(this.config.integrations.mode);
  }
}

@Controller('billing')
@UseGuards(IntegrationsEnabledGuard)
export class BillingController {
  constructor(private readonly charges: ChargesService, private readonly billing: BillingService) {}

  @Get('charges') @RequirePermissions('charge:read')
  listCharges(@CurrentPrincipal() a: AuthPrincipal, @Query() q: ListChargesQuery) { return this.charges.list(a, q); }
  @Post('charges') @RequirePermissions('charge:manage')
  createCharge(@CurrentPrincipal() a: AuthPrincipal, @Body() dto: CreateChargeDto, @Meta() m: RequestMeta) { return this.charges.create(a, dto, m); }
  @Get('charges/:id') @RequirePermissions('charge:read')
  getCharge(@CurrentPrincipal() a: AuthPrincipal, @Param('id', uuid()) id: string) { return this.charges.get(a, id); }
  @Post('charges/:id/pay') @HttpCode(200) @RequirePermissions('charge:manage')
  pay(@CurrentPrincipal() a: AuthPrincipal, @Param('id', uuid()) id: string, @Body() dto: PayChargeDto, @Meta() m: RequestMeta) { return this.charges.pay(a, id, dto, m); }
  @Post('charges/:id/void') @HttpCode(200) @RequirePermissions('charge:manage')
  voidCharge(@CurrentPrincipal() a: AuthPrincipal, @Param('id', uuid()) id: string, @Body() dto: VoidChargeDto, @Meta() m: RequestMeta) { return this.charges.void(a, id, dto, m); }

  @Post('charges/:id/document') @RequirePermissions('billing:manage')
  emit(@CurrentPrincipal() a: AuthPrincipal, @Param('id', uuid()) id: string, @Body() dto: EmitDocumentDto, @Meta() m: RequestMeta) { return this.billing.emit(a, id, dto, m); }
  @Get('documents') @RequirePermissions('billing:read')
  listDocuments(@CurrentPrincipal() a: AuthPrincipal, @Query() q: ListDocumentsQuery) { return this.billing.list(a, q); }
  @Get('documents/:id') @RequirePermissions('billing:read')
  getDocument(@CurrentPrincipal() a: AuthPrincipal, @Param('id', uuid()) id: string) { return this.billing.get(a, id); }
  @Post('documents/:id/retry') @HttpCode(200) @RequirePermissions('billing:manage')
  retry(@CurrentPrincipal() a: AuthPrincipal, @Param('id', uuid()) id: string, @Meta() m: RequestMeta) { return this.billing.retry(a, id, m); }
  @Post('documents/:id/reconcile') @HttpCode(200) @RequirePermissions('billing:manage')
  reconcile(@CurrentPrincipal() a: AuthPrincipal, @Param('id', uuid()) id: string, @Meta() m: RequestMeta) { return this.billing.reconcile(a, id, m); }
  @Post('reconcile') @HttpCode(200) @RequirePermissions('billing:manage')
  reconcileAll(@CurrentPrincipal() a: AuthPrincipal, @Meta() m: RequestMeta) { return this.billing.reconcileAll(a, m); }
  @Get('documents/:id/pdf') @RequirePermissions('billing:read')
  async pdf(@CurrentPrincipal() a: AuthPrincipal, @Param('id', uuid()) id: string, @Meta() m: RequestMeta, @Res({ passthrough: true }) res: Response) {
    const out = await this.billing.pdf(a, id, m);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(out.body, { type: 'application/pdf', disposition: `attachment; filename="${out.filename}"`, length: out.body.length });
  }

  @Get('outbox') @RequirePermissions('billing:read')
  outbox(@CurrentPrincipal() a: AuthPrincipal, @Query() q: ListOutboxQuery) { return this.billing.outboxList(a, q); }
  @Post('outbox/process') @HttpCode(200) @RequirePermissions('billing:manage')
  process(@CurrentPrincipal() a: AuthPrincipal, @Meta() m: RequestMeta) { return this.billing.outboxProcess(a, m); }
}

@Controller()
@UseGuards(IntegrationsEnabledGuard)
export class LoyaltyController {
  constructor(private readonly loyalty: LoyaltyService) {}

  @Get('loyalty/patients/:id') @RequirePermissions('loyalty:read')
  summary(@CurrentPrincipal() a: AuthPrincipal, @Param('id', uuid()) id: string) { return this.loyalty.summary(a, id); }
  @Post('loyalty/patients/:id/redeem') @HttpCode(200) @RequirePermissions('loyalty:manage')
  redeem(@CurrentPrincipal() a: AuthPrincipal, @Param('id', uuid()) id: string, @Body() dto: RedeemDto, @Meta() m: RequestMeta) { return this.loyalty.redeem(a, id, dto, m); }
  @Get('reviews/summary') @RequirePermissions('loyalty:read')
  reviews(@CurrentPrincipal() a: AuthPrincipal) { return this.loyalty.reviewSummary(a); }
}
