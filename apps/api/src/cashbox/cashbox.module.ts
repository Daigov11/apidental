import { Module } from '@nestjs/common';
import { CashboxConfigService } from './cashbox-config.service.js';
import { CashboxController } from './cashbox.controller.js';
import { CashboxService } from './cashbox.service.js';

@Module({ controllers: [CashboxController], providers: [CashboxService, CashboxConfigService], exports: [CashboxService] })
export class CashboxModule {}
