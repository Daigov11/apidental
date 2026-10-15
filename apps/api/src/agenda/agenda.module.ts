import { Module } from '@nestjs/common';
import { ClinicalModule } from '../clinical/clinical.module.js';
import { AgendaAvailabilityService } from './agenda-availability.service.js';
import { AgendaConfigService } from './agenda-config.service.js';
import { AgendaController, AppointmentsController } from './agenda.controller.js';
import { AppointmentsService } from './appointments.service.js';

@Module({
  imports: [ClinicalModule],
  controllers: [AgendaController, AppointmentsController],
  providers: [AgendaConfigService, AgendaAvailabilityService, AppointmentsService],
  exports: [AppointmentsService],
})
export class AgendaModule {}
