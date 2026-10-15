import { Module } from '@nestjs/common';
import { AppConfig } from '../config/app-config.js';
import type { PrismaDb } from '../prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';
import { BillingDeliveryService } from './billing-delivery.service.js';
import { BillingService } from './billing.service.js';
import { ChargesService } from './charges.service.js';
import { BILLING_PROVIDER, LOYALTY_PROVIDER, REVIEW_PROVIDER } from './integrations.constants.js';
import { BillingController, IntegrationsStatusController, LoyaltyController } from './integrations.controller.js';
import { IntegrationsEnabledGuard } from './integrations.guard.js';
import { LoyaltyService } from './loyalty.service.js';
import { OutboxService } from './outbox.service.js';
import type { BillingProvider } from './providers/billing-provider.js';
import { disabledProvider } from './providers/disabled.js';
import type { LoyaltyProvider } from './providers/loyalty-provider.js';
import { MockBillingProvider } from './providers/mock/mock-billing.provider.js';
import { MockLoyaltyProvider } from './providers/mock/mock-loyalty.provider.js';
import { MockReviewProvider } from './providers/mock/mock-review.provider.js';
import type { ReviewProvider } from './providers/review-provider.js';

/**
 * Integraciones con Apiworking. SOLO existen simuladores (INTEGRATIONS_MODE=mock): ni credenciales, ni endpoints reales.
 * Los servicios dependen de las interfaces (BillingProvider, LoyaltyProvider, ReviewProvider); un adaptador real las
 * implementaría y reemplazaría a los simuladores en estas fábricas sin tocar el resto.
 */
const pick = <T extends object>(token: symbol, mock: new (db: PrismaDb) => T) => ({
  provide: token,
  inject: [AppConfig, PRISMA],
  useFactory: (config: AppConfig, db: PrismaDb): T => (config.integrations.mode === 'mock' ? new mock(db) : disabledProvider<T>()),
});

@Module({
  controllers: [IntegrationsStatusController, BillingController, LoyaltyController],
  providers: [
    pick<BillingProvider>(BILLING_PROVIDER, MockBillingProvider),
    pick<LoyaltyProvider>(LOYALTY_PROVIDER, MockLoyaltyProvider),
    pick<ReviewProvider>(REVIEW_PROVIDER, MockReviewProvider),
    IntegrationsEnabledGuard,
    BillingDeliveryService,
    OutboxService,
    ChargesService,
    BillingService,
    LoyaltyService,
  ],
})
export class IntegrationsModule {}
