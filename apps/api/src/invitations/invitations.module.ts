import { Module, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { AppConfig } from '../config/app-config.js';
import { ProvisioningModule } from '../provisioning/provisioning.module.js';
import { UsersModule } from '../users/users.module.js';
import { createDelivery, INVITATION_DELIVERY } from './delivery/invitation-delivery.js';
import { InvitationsController } from './invitations.controller.js';
import { InvitationsService } from './invitations.service.js';

const SWEEP_MS = 5 * 60_000;

@Module({
  imports: [UsersModule, ProvisioningModule],
  controllers: [InvitationsController],
  providers: [
    InvitationsService,
    { provide: INVITATION_DELIVERY, inject: [AppConfig], useFactory: createDelivery },
  ],
})
export class InvitationsModule implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly invitations: InvitationsService,
    private readonly config: AppConfig,
  ) {}

  /** Barrido periódico de vencimientos (además del vencimiento perezoso al listar/aceptar). No corre en pruebas. */
  onModuleInit(): void {
    if (this.config.isTest) return;
    this.timer = setInterval(() => void this.invitations.expireDue().catch(() => undefined), SWEEP_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
