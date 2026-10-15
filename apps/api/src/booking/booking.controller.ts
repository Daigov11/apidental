import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { CurrentPrincipal } from '../common/decorators/current-principal.decorator.js';
import { RequirePermissions } from '../common/decorators/permissions.decorator.js';
import { Public } from '../common/decorators/public.decorator.js';
import { Meta, type RequestMeta } from '../common/utils/request-meta.js';
import { AcceptBookingRequestDto, CreateBookingRequestDto, ListBookingRequestsQuery, PublicAvailabilityQuery, RejectBookingRequestDto } from './booking.dto.js';
import { BookingRequestsService } from './booking-requests.service.js';
import { PublicBookingService } from './public-booking.service.js';

const uuid = () => new ParseUUIDPipe();

/** Sin sesión. Los límites por IP son más estrictos que los generales. */
@Controller('public/booking')
export class PublicBookingController {
  constructor(private readonly pub: PublicBookingService) {}

  @Public() @Get('info')
  info() { return this.pub.info(); }

  @Public() @Get('availability') @Throttle({ default: { limit: 40, ttl: 60_000 } })
  availability(@Query() q: PublicAvailabilityQuery) { return this.pub.availabilityOf(q); }

  @Public() @Post('requests') @Throttle({ default: { limit: 6, ttl: 600_000 } })
  create(@Body() dto: CreateBookingRequestDto, @Meta() m: RequestMeta) { return this.pub.create(dto, m); }
}

/** Personal con permiso para gestionar citas. */
@Controller('booking-requests')
export class BookingRequestsController {
  constructor(private readonly requests: BookingRequestsService) {}

  @Get() @RequirePermissions('appointment:manage')
  list(@CurrentPrincipal() a: AuthPrincipal, @Query() q: ListBookingRequestsQuery) { return this.requests.list(a, q); }

  @Get('count') @RequirePermissions('appointment:manage')
  count(@CurrentPrincipal() a: AuthPrincipal) { return this.requests.count(a); }

  @Post(':id/accept') @HttpCode(200) @RequirePermissions('appointment:manage')
  accept(@CurrentPrincipal() a: AuthPrincipal, @Param('id', uuid()) id: string, @Body() dto: AcceptBookingRequestDto, @Meta() m: RequestMeta) { return this.requests.accept(a, id, dto, m); }

  @Post(':id/reject') @HttpCode(200) @RequirePermissions('appointment:manage')
  reject(@CurrentPrincipal() a: AuthPrincipal, @Param('id', uuid()) id: string, @Body() dto: RejectBookingRequestDto, @Meta() m: RequestMeta) { return this.requests.reject(a, id, dto, m); }
}
