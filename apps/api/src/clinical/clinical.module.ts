import { Module } from '@nestjs/common';
import { CareRelationshipsController } from './care-relationships.controller.js';
import { CareRelationshipsService } from './care-relationships.service.js';
import { ClinicalAccessService } from './clinical-access.service.js';
import { ClinicalSummaryService } from './clinical-summary.service.js';
import { ClinicalAlertsService } from './clinical-alerts.service.js';
import { ClinicalHistoryController } from './clinical-history.controller.js';
import { ClinicalHistoryService } from './clinical-history.service.js';
import { ClinicalController } from './clinical.controller.js';

@Module({
  controllers: [
    CareRelationshipsController,
    ClinicalController,
    ClinicalHistoryController,
  ],
  providers: [
    CareRelationshipsService,
    ClinicalAccessService,
    ClinicalSummaryService,
    ClinicalHistoryService,
    ClinicalAlertsService,
  ],
  exports: [ClinicalAccessService, CareRelationshipsService],
})
export class ClinicalModule {}
