import { Global, Module } from '@nestjs/common';
import { AppConfig } from '../../config/app-config.js';
import { createDelivery, INVITATION_DELIVERY } from './invitation-delivery.js';

/** Un único canal de entrega (el adaptador firmado) compartido por invitaciones y recuperación de contraseña. */
@Global()
@Module({
  providers: [{ provide: INVITATION_DELIVERY, inject: [AppConfig], useFactory: createDelivery }],
  exports: [INVITATION_DELIVERY],
})
export class DeliveryModule {}
