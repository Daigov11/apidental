import { Module } from '@nestjs/common';
import { CareRelationshipsController } from './care-relationships.controller.js';
import { CareRelationshipsService } from './care-relationships.service.js';
import { ClinicalAccessService } from './clinical-access.service.js';
import { ClinicalSummaryService } from './clinical-summary.service.js';
import { ClinicalAllergyAssessmentService } from './clinical-allergy-assessment.service.js';
import { ClinicalCareController } from './clinical-care.controller.js';
import { ClinicalDiagnosesService } from './clinical-diagnoses.service.js';
import { ClinicalNotesService } from './clinical-notes.service.js';
import { ClinicalSheetService } from './clinical-sheet.service.js';
import { ClinicalProceduresService } from './clinical-procedures.service.js';
import { ClinicalVisitsService } from './clinical-visits.service.js';
import { ProcedureDefinitionsService } from './procedure-definitions.service.js';
import { ClinicalAlertsService } from './clinical-alerts.service.js';
import { ClinicalHistoryController } from './clinical-history.controller.js';
import { ClinicalHistoryService } from './clinical-history.service.js';
import { ClinicalController } from './clinical.controller.js';

@Module({
  controllers: [
    CareRelationshipsController,
    ClinicalController,
    ClinicalHistoryController,
    ClinicalCareController,
  ],
  providers: [
    CareRelationshipsService,
    ClinicalAccessService,
    ClinicalSummaryService,
    ClinicalHistoryService,
    ClinicalAlertsService,
    ClinicalAllergyAssessmentService,
    ProcedureDefinitionsService,
    ClinicalVisitsService,
    ClinicalDiagnosesService,
    ClinicalProceduresService,
    ClinicalNotesService,
    ClinicalSheetService,
  ],
  exports: [ClinicalAccessService, CareRelationshipsService],
})
export class ClinicalModule {}
