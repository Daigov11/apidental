import { Module } from '@nestjs/common';
import { AgendaAvailabilityService } from '../agenda/agenda-availability.service.js';
import { AgendaConfigService } from '../agenda/agenda-config.service.js';
import { AgendaModule } from '../agenda/agenda.module.js';
import { SiteSettingsModule } from '../site/site-settings.js';
import { BookingRequestsService } from './booking-requests.service.js';
import { BookingRequestsController, PublicBookingController } from './booking.controller.js';
import { PublicBookingService } from './public-booking.service.js';

@Module({
  imports: [AgendaModule, SiteSettingsModule],
  controllers: [PublicBookingController, BookingRequestsController],
  providers: [PublicBookingService, BookingRequestsService, AgendaAvailabilityService, AgendaConfigService],
})
export class BookingModule {}
