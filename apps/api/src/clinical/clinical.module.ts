import { Module } from '@nestjs/common';
import { CareRelationshipsController } from './care-relationships.controller.js';
import { CareRelationshipsService } from './care-relationships.service.js';
import { ClinicalAccessService } from './clinical-access.service.js';
import { ClinicalSummaryService } from './clinical-summary.service.js';
import { ClinicalController } from './clinical.controller.js';

@Module({
  controllers: [CareRelationshipsController, ClinicalController],
  providers: [
    CareRelationshipsService,
    ClinicalAccessService,
    ClinicalSummaryService,
  ],
  exports: [ClinicalAccessService, CareRelationshipsService],
})
export class ClinicalModule {}
