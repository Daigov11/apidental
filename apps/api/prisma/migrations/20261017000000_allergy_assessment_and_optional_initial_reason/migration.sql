-- AlterTable
ALTER TABLE `clinical_alerts` MODIFY `change_reason` VARCHAR(300) NULL;

-- AlterTable
ALTER TABLE `clinical_history_entries` MODIFY `change_reason` VARCHAR(300) NULL;

-- CreateTable
CREATE TABLE `clinical_allergy_assessments` (
    `id` CHAR(36) NOT NULL,
    `clinic_id` CHAR(36) NOT NULL,
    `patient_id` CHAR(36) NOT NULL,
    `version` INTEGER NOT NULL,
    `supersedes_id` CHAR(36) NULL,
    `current_key` CHAR(36) NULL,
    `status` ENUM('NOT_ASKED', 'NO_KNOWN_ALLERGIES', 'ALLERGIES_RECORDED') NOT NULL,
    `assessed_on` DATE NOT NULL,
    `source` ENUM('PATIENT', 'GUARDIAN', 'DOCUMENT', 'PROFESSIONAL', 'OTHER') NOT NULL,
    `observations` VARCHAR(500) NULL,
    `change_kind` ENUM('CREATED', 'CORRECTED', 'RECTIFIED', 'DEACTIVATED', 'REACTIVATED', 'MARKED_IN_ERROR') NOT NULL,
    `change_reason` VARCHAR(300) NULL,
    `automatic` BOOLEAN NOT NULL DEFAULT false,
    `created_by_id` CHAR(36) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `clinical_allergy_assessments_current_key_key`(`current_key`),
    INDEX `clinical_allergy_assessments_clinic_id_patient_id_idx`(`clinic_id`, `patient_id`),
    UNIQUE INDEX `clinical_allergy_assessments_patient_id_version_key`(`patient_id`, `version`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `clinical_allergy_assessments` ADD CONSTRAINT `clinical_allergy_assessments_patient_id_clinic_id_fkey` FOREIGN KEY (`patient_id`, `clinic_id`) REFERENCES `patients`(`id`, `clinic_id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- 3.2.1: motivo opcional en el alta + evaluación de alergias (versionada, con invariante en la base)
-- ===========================================================================

-- clinical_history_entries: el alta inicial (versión 1) ya NO exige motivo; todo cambio posterior sí.
DROP TRIGGER `clinical_history_entries_insert_chain`;

CREATE TRIGGER `clinical_history_entries_insert_chain`
  BEFORE INSERT ON `clinical_history_entries` FOR EACH ROW
BEGIN
  IF NEW.`version` > 1 AND CHAR_LENGTH(TRIM(COALESCE(NEW.`change_reason`, ''))) < 3 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_history_entries: todo cambio posterior al alta exige un motivo de al menos 3 caracteres';
  END IF;
  IF NEW.`version` = 1 AND NEW.`change_reason` IS NOT NULL AND CHAR_LENGTH(TRIM(NEW.`change_reason`)) < 3 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_history_entries: si se informa un motivo debe tener al menos 3 caracteres';
  END IF;
  IF NEW.`current_key` IS NULL OR NEW.`current_key` <> NEW.`item_id` THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_history_entries: una versión nueva nace como la vigente del elemento';
  END IF;
  IF NEW.`version` = 1 THEN
    IF NEW.`supersedes_id` IS NOT NULL OR NEW.`change_kind` <> 'CREATED' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_history_entries: la versión 1 es el alta del elemento';
    END IF;
  ELSE
    IF NEW.`change_kind` = 'CREATED' OR NEW.`supersedes_id` IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_history_entries: las versiones posteriores reemplazan a la anterior';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM `clinical_history_entries` p
      WHERE p.`id` = NEW.`supersedes_id` AND p.`item_id` = NEW.`item_id` AND p.`version` = NEW.`version` - 1
        AND p.`patient_id` = NEW.`patient_id` AND p.`clinic_id` = NEW.`clinic_id` AND p.`kind` = NEW.`kind`
    ) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_history_entries: la versión debe continuar la anterior del mismo elemento y paciente';
    END IF;
  END IF;
END;

-- clinical_alerts: el alta inicial (versión 1) ya NO exige motivo; todo cambio posterior sí.
DROP TRIGGER `clinical_alerts_insert_chain`;

CREATE TRIGGER `clinical_alerts_insert_chain`
  BEFORE INSERT ON `clinical_alerts` FOR EACH ROW
BEGIN
  IF NEW.`version` > 1 AND CHAR_LENGTH(TRIM(COALESCE(NEW.`change_reason`, ''))) < 3 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_alerts: todo cambio posterior al alta exige un motivo de al menos 3 caracteres';
  END IF;
  IF NEW.`version` = 1 AND NEW.`change_reason` IS NOT NULL AND CHAR_LENGTH(TRIM(NEW.`change_reason`)) < 3 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_alerts: si se informa un motivo debe tener al menos 3 caracteres';
  END IF;
  IF NEW.`current_key` IS NULL OR NEW.`current_key` <> NEW.`item_id` THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_alerts: una versión nueva nace como la vigente del elemento';
  END IF;
  IF NEW.`version` = 1 THEN
    IF NEW.`supersedes_id` IS NOT NULL OR NEW.`change_kind` <> 'CREATED' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_alerts: la versión 1 es el alta del elemento';
    END IF;
  ELSE
    IF NEW.`change_kind` = 'CREATED' OR NEW.`supersedes_id` IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_alerts: las versiones posteriores reemplazan a la anterior';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM `clinical_alerts` p
      WHERE p.`id` = NEW.`supersedes_id` AND p.`item_id` = NEW.`item_id` AND p.`version` = NEW.`version` - 1
        AND p.`patient_id` = NEW.`patient_id` AND p.`clinic_id` = NEW.`clinic_id`
    ) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_alerts: la versión debe continuar la anterior del mismo elemento y paciente';
    END IF;
  END IF;
END;

-- Evaluación de alergias: una cadena por paciente (la vigente lleva current_key = patient_id).
CREATE TRIGGER `clinical_allergy_assessments_insert_chain`
  BEFORE INSERT ON `clinical_allergy_assessments` FOR EACH ROW
BEGIN
  DECLARE active_allergies INT;
  IF NEW.`version` > 1 AND CHAR_LENGTH(TRIM(COALESCE(NEW.`change_reason`, ''))) < 3 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_allergy_assessments: todo cambio posterior al alta exige un motivo de al menos 3 caracteres';
  END IF;
  IF NEW.`current_key` IS NULL OR NEW.`current_key` <> NEW.`patient_id` THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_allergy_assessments: una versión nueva nace como la vigente del paciente';
  END IF;
  IF NEW.`version` = 1 THEN
    IF NEW.`supersedes_id` IS NOT NULL OR NEW.`change_kind` <> 'CREATED' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_allergy_assessments: la versión 1 es el alta de la evaluación';
    END IF;
  ELSE
    IF NEW.`change_kind` = 'CREATED' OR NEW.`supersedes_id` IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_allergy_assessments: las versiones posteriores reemplazan a la anterior';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM `clinical_allergy_assessments` p
      WHERE p.`id` = NEW.`supersedes_id` AND p.`patient_id` = NEW.`patient_id` AND p.`clinic_id` = NEW.`clinic_id`
        AND p.`version` = NEW.`version` - 1
    ) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_allergy_assessments: la versión debe continuar la anterior del mismo paciente';
    END IF;
  END IF;
  -- Invariante: ALLERGIES_RECORDED <=> existe al menos una alergia activa vigente.
  SELECT COUNT(*) INTO active_allergies FROM `clinical_history_entries` e
   WHERE e.`patient_id` = NEW.`patient_id` AND e.`clinic_id` = NEW.`clinic_id`
     AND e.`kind` = 'ALLERGY' AND e.`status` = 'ACTIVE' AND e.`current_key` IS NOT NULL;
  IF NEW.`status` = 'ALLERGIES_RECORDED' AND active_allergies = 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_allergy_assessments: ALLERGIES_RECORDED exige al menos una alergia activa';
  END IF;
  IF NEW.`status` <> 'ALLERGIES_RECORDED' AND active_allergies > 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_allergy_assessments: existen alergias activas; el estado debe ser ALLERGIES_RECORDED';
  END IF;
END;

CREATE TRIGGER `clinical_allergy_assessments_only_release_current`
  BEFORE UPDATE ON `clinical_allergy_assessments` FOR EACH ROW
BEGIN
  IF OLD.`current_key` IS NULL OR NEW.`current_key` IS NOT NULL
     OR NOT (NEW.`patient_id` <=> OLD.`patient_id`) OR NOT (NEW.`clinic_id` <=> OLD.`clinic_id`)
     OR NOT (NEW.`version` <=> OLD.`version`) OR NOT (NEW.`status` <=> OLD.`status`)
     OR NOT (NEW.`assessed_on` <=> OLD.`assessed_on`) OR NOT (NEW.`source` <=> OLD.`source`)
     OR NOT (NEW.`observations` <=> OLD.`observations`) OR NOT (NEW.`change_reason` <=> OLD.`change_reason`)
     OR NOT (NEW.`change_kind` <=> OLD.`change_kind`) OR NOT (NEW.`automatic` <=> OLD.`automatic`)
     OR NOT (NEW.`supersedes_id` <=> OLD.`supersedes_id`) OR NOT (NEW.`created_by_id` <=> OLD.`created_by_id`)
     OR NOT (NEW.`created_at` <=> OLD.`created_at`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_allergy_assessments: el historial es inmutable; solo se reemplaza la versión vigente';
  END IF;
END;

CREATE TRIGGER `clinical_allergy_assessments_block_delete`
  BEFORE DELETE ON `clinical_allergy_assessments` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_allergy_assessments: los registros clínicos no se eliminan';
END;
