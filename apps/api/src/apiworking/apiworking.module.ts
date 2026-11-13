import { Global, Module } from '@nestjs/common';
import { ApiworkingClient } from './apiworking.client.js';
import { ApiworkingAuthController, ApiworkingController } from './apiworking.controller.js';
import { ApiworkingAuthService } from './apiworking-auth.service.js';
import { CashboxModule } from '../cashbox/cashbox.module.js';
import { ProductsModule } from '../products/products.js';
import { ApiworkingContingencyService } from './apiworking-contingency.service.js';
import { ApiworkingCashService } from './apiworking-cash.service.js';
import { ApiworkingClientsService } from './apiworking-clients.service.js';
import { ApiworkingSalesService } from './apiworking-sales.service.js';
import { ApiworkingSessionStore } from './apiworking-session.store.js';
import { ApiworkingWhatsappService } from './apiworking-whatsapp.service.js';

/**
 * Apiworking REAL (login, clientes y ventas por registro-documento). Convive con los simuladores de `integrations/`
 * (que siguen siendo solo para demostración) y no comparte tablas con ellos. Global solo por el almacén de sesiones
 * externas, que AuthService necesita para cerrarlas al cerrar la sesión local.
 */
@Global()
@Module({
  imports: [CashboxModule, ProductsModule],
  controllers: [ApiworkingAuthController, ApiworkingController],
  providers: [ApiworkingClient, ApiworkingSessionStore, ApiworkingAuthService, ApiworkingClientsService, ApiworkingSalesService, ApiworkingCashService, ApiworkingContingencyService, ApiworkingWhatsappService],
  exports: [ApiworkingSessionStore, ApiworkingClient, ApiworkingWhatsappService],
})
export class ApiworkingModule {}
