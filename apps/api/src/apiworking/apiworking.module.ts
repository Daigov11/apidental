import { Global, Module } from '@nestjs/common';
import { ApiworkingClient } from './apiworking.client.js';
import { ApiworkingAuthController, ApiworkingController } from './apiworking.controller.js';
import { ApiworkingAuthService } from './apiworking-auth.service.js';
import { ApiworkingClientsService } from './apiworking-clients.service.js';
import { ApiworkingSalesService } from './apiworking-sales.service.js';
import { ApiworkingSessionStore } from './apiworking-session.store.js';

/**
 * Apiworking REAL (login, clientes y ventas por registro-documento). Convive con los simuladores de `integrations/`
 * (que siguen siendo solo para demostración) y no comparte tablas con ellos. Global solo por el almacén de sesiones
 * externas, que AuthService necesita para cerrarlas al cerrar la sesión local.
 */
@Global()
@Module({
  controllers: [ApiworkingAuthController, ApiworkingController],
  providers: [ApiworkingClient, ApiworkingSessionStore, ApiworkingAuthService, ApiworkingClientsService, ApiworkingSalesService],
  exports: [ApiworkingSessionStore],
})
export class ApiworkingModule {}
