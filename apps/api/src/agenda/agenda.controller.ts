import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { CurrentPrincipal } from '../common/decorators/current-principal.decorator.js';
import { RequirePermissions } from '../common/decorators/permissions.decorator.js';
import { Meta, type RequestMeta } from '../common/utils/request-meta.js';
import { AgendaAvailabilityService } from './agenda-availability.service.js';
import { AgendaConfigService } from './agenda-config.service.js';
import { AppointmentsService } from './appointments.service.js';
import {
  AvailabilityQuery, BranchQuery, CalendarQuery, CreateAppointmentDto, CreateBlockDto, CreateRoomDto, CreateScheduleRuleDto, CreateServiceDto, CreateSpecialtyDto,
  DeactivateRuleDto, ListAppointmentsQuery, ListSchedulesQuery, ReasonVersionDto, ReleaseBlockDto, RescheduleAppointmentDto, SetDentistSpecialtiesDto, UpdateNotesDto,
  UpdateRoomDto, UpdateServiceDto, UpdateSpecialtyDto, VersionDto,
} from './dto/agenda.dto.js';

const uuid = () => new ParseUUIDPipe();

/** Configuración y consulta de la agenda (no contiene datos clínicos). */
@Controller('agenda')
export class AgendaController {
  constructor(
    private readonly config: AgendaConfigService,
    private readonly availability: AgendaAvailabilityService,
  ) {}

  @Get('rooms') @RequirePermissions('appointment:read')
  rooms(@CurrentPrincipal() a: AuthPrincipal, @Query() q: BranchQuery) { return this.config.listRooms(a, q.branchId); }
  @Post('rooms') @RequirePermissions('agenda:manage')
  createRoom(@CurrentPrincipal() a: AuthPrincipal, @Body() dto: CreateRoomDto, @Meta() m: RequestMeta) { return this.config.createRoom(a, dto, m); }
  @Patch('rooms/:id') @RequirePermissions('agenda:manage')
  updateRoom(@CurrentPrincipal() a: AuthPrincipal, @Param('id', uuid()) id: string, @Body() dto: UpdateRoomDto, @Meta() m: RequestMeta) { return this.config.updateRoom(a, id, dto, m); }

  @Get('specialties') @RequirePermissions('appointment:read')
  specialties(@CurrentPrincipal() a: AuthPrincipal) { return this.config.listSpecialties(a); }
  @Post('specialties') @RequirePermissions('agenda:manage')
  createSpecialty(@CurrentPrincipal() a: AuthPrincipal, @Body() dto: CreateSpecialtyDto, @Meta() m: RequestMeta) { return this.config.createSpecialty(a, dto, m); }
  @Patch('specialties/:id') @RequirePermissions('agenda:manage')
  updateSpecialty(@CurrentPrincipal() a: AuthPrincipal, @Param('id', uuid()) id: string, @Body() dto: UpdateSpecialtyDto, @Meta() m: RequestMeta) { return this.config.updateSpecialty(a, id, dto, m); }

  @Get('services') @RequirePermissions('appointment:read')
  services(@CurrentPrincipal() a: AuthPrincipal) { return this.config.listServices(a); }
  @Post('services') @RequirePermissions('agenda:manage')
  createService(@CurrentPrincipal() a: AuthPrincipal, @Body() dto: CreateServiceDto, @Meta() m: RequestMeta) { return this.config.createService(a, dto, m); }
  @Patch('services/:id') @RequirePermissions('agenda:manage')
  updateService(@CurrentPrincipal() a: AuthPrincipal, @Param('id', uuid()) id: string, @Body() dto: UpdateServiceDto, @Meta() m: RequestMeta) { return this.config.updateService(a, id, dto, m); }

  @Get('dentists') @RequirePermissions('appointment:read')
  dentists(@CurrentPrincipal() a: AuthPrincipal, @Query() q: BranchQuery) { return this.config.listDentists(a, q.branchId); }
  @Put('dentists/:userId/specialties') @RequirePermissions('agenda:manage')
  setSpecialties(@CurrentPrincipal() a: AuthPrincipal, @Param('userId', uuid()) id: string, @Body() dto: SetDentistSpecialtiesDto, @Meta() m: RequestMeta) { return this.config.setDentistSpecialties(a, id, dto.specialtyIds, m); }

  @Get('schedules') @RequirePermissions('appointment:read')
  schedules(@CurrentPrincipal() a: AuthPrincipal, @Query() q: ListSchedulesQuery) { return this.config.listRules(a, q); }
  @Post('schedules') @RequirePermissions('agenda:manage')
  createSchedule(@CurrentPrincipal() a: AuthPrincipal, @Body() dto: CreateScheduleRuleDto, @Meta() m: RequestMeta) { return this.config.createRule(a, dto, m); }
  @Post('schedules/:id/deactivate') @HttpCode(200) @RequirePermissions('agenda:manage')
  deactivateSchedule(@CurrentPrincipal() a: AuthPrincipal, @Param('id', uuid()) id: string, @Body() dto: DeactivateRuleDto, @Meta() m: RequestMeta) { return this.config.deactivateRule(a, id, dto, m); }

  @Post('blocks') @RequirePermissions('agenda:manage')
  createBlock(@CurrentPrincipal() a: AuthPrincipal, @Body() dto: CreateBlockDto, @Meta() m: RequestMeta) { return this.availability.createBlock(a, dto, m); }
  @Post('blocks/:id/release') @HttpCode(200) @RequirePermissions('agenda:manage')
  releaseBlock(@CurrentPrincipal() a: AuthPrincipal, @Param('id', uuid()) id: string, @Body() dto: ReleaseBlockDto, @Meta() m: RequestMeta) { return this.availability.releaseBlock(a, id, dto, m); }

  @Get('availability') @RequirePermissions('appointment:read')
  availabilityOf(@CurrentPrincipal() a: AuthPrincipal, @Query() q: AvailabilityQuery) { return this.availability.availability(a, q); }
  @Get('calendar') @RequirePermissions('appointment:read')
  calendar(@CurrentPrincipal() a: AuthPrincipal, @Query() q: CalendarQuery) { return this.availability.calendar(a, q); }
}

@Controller('appointments')
export class AppointmentsController {
  constructor(private readonly appointments: AppointmentsService) {}

  @Get() @RequirePermissions('appointment:read')
  list(@CurrentPrincipal() a: AuthPrincipal, @Query() q: ListAppointmentsQuery) { return this.appointments.list(a, q); }
  @Post() @RequirePermissions('appointment:manage')
  create(@CurrentPrincipal() a: AuthPrincipal, @Body() dto: CreateAppointmentDto, @Meta() m: RequestMeta) { return this.appointments.create(a, dto, m); }
  @Get(':id') @RequirePermissions('appointment:read')
  get(@CurrentPrincipal() a: AuthPrincipal, @Param('id', uuid()) id: string) { return this.appointments.get(a, id); }
  @Patch(':id') @RequirePermissions('appointment:manage')
  notes(@CurrentPrincipal() a: AuthPrincipal, @Param('id', uuid()) id: string, @Body() dto: UpdateNotesDto, @Meta() m: RequestMeta) { return this.appointments.updateNotes(a, id, dto, m); }
  @Post(':id/confirm') @HttpCode(200) @RequirePermissions('appointment:manage')
  confirm(@CurrentPrincipal() a: AuthPrincipal, @Param('id', uuid()) id: string, @Body() dto: VersionDto, @Meta() m: RequestMeta) { return this.appointments.confirm(a, id, dto, m); }
  @Post(':id/reschedule') @HttpCode(200) @RequirePermissions('appointment:manage')
  reschedule(@CurrentPrincipal() a: AuthPrincipal, @Param('id', uuid()) id: string, @Body() dto: RescheduleAppointmentDto, @Meta() m: RequestMeta) { return this.appointments.reschedule(a, id, dto, m); }
  @Post(':id/cancel') @HttpCode(200) @RequirePermissions('appointment:manage')
  cancel(@CurrentPrincipal() a: AuthPrincipal, @Param('id', uuid()) id: string, @Body() dto: ReasonVersionDto, @Meta() m: RequestMeta) { return this.appointments.cancel(a, id, dto, m); }
  @Post(':id/no-show') @HttpCode(200) @RequirePermissions('appointment:manage')
  noShow(@CurrentPrincipal() a: AuthPrincipal, @Param('id', uuid()) id: string, @Body() dto: ReasonVersionDto, @Meta() m: RequestMeta) { return this.appointments.markNoShow(a, id, dto, m); }
  @Post(':id/start-attention') @HttpCode(200) @RequirePermissions('appointment:attend', 'clinical:write')
  start(@CurrentPrincipal() a: AuthPrincipal, @Param('id', uuid()) id: string, @Meta() m: RequestMeta) { return this.appointments.startAttention(a, id, m); }
}
