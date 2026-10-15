import { Module } from '@nestjs/common';
import { InvitationsModule } from '../invitations/invitations.module.js';
import { ProvisioningModule } from '../provisioning/provisioning.module.js';
import { MaintenanceService } from './maintenance.service.js';

@Module({
  imports: [InvitationsModule, ProvisioningModule],
  providers: [MaintenanceService],
  exports: [MaintenanceService],
})
export class MaintenanceModule {}
