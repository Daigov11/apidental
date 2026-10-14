import { Module } from '@nestjs/common';
import { TenancyController } from './tenancy.controller.js';
import { TenancyService } from './tenancy.service.js';

@Module({ controllers: [TenancyController], providers: [TenancyService] })
export class TenancyModule {}
