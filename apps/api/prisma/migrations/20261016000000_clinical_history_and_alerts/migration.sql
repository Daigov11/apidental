-- CreateTable
CREATE TABLE `clinical_history_entries` (
    `id` CHAR(36) NOT NULL,
    `clinic_id` CHAR(36) NOT NULL,
    `patient_id` CHAR(36) NOT NULL,
    `item_id` CHAR(36) NOT NULL,
    `version` INTEGER NOT NULL,
    `supersedes_id` CHAR(36) NULL,
    `current_key` CHAR(36) NULL,
    `kind` ENUM('BACKGROUND', 'ALLERGY') NOT NULL,
    `label` VARCHAR(200) NOT NULL,
    `condition` VARCHAR(300) NULL,
    `category` VARCHAR(60) NULL,
    `severity` ENUM('NOT_SPECIFIED', 'MILD', 'MODERATE', 'SEVERE') NOT NULL DEFAULT 'NOT_SPECIFIED',
    `status` ENUM('ACTIVE', 'INACTIVE', 'ENTERED_IN_ERROR') NOT NULL DEFAULT 'ACTIVE',
    `is_critical` BOOLEAN NOT NULL DEFAULT false,
    `onset_date` DATE NULL,
    `source` ENUM('PATIENT', 'GUARDIAN', 'DOCUMENT', 'PROFESSIONAL', 'OTHER') NOT NULL,
    `observations` VARCHAR(1000) NULL,
    `change_kind` ENUM('CREATED', 'CORRECTED', 'RECTIFIED', 'DEACTIVATED', 'REACTIVATED', 'MARKED_IN_ERROR') NOT NULL,
    `change_reason` VARCHAR(300) NOT NULL,
    `changed_fields` JSON NULL,
    `created_by_id` CHAR(36) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `clinical_history_entries_current_key_key`(`current_key`),
    INDEX `clinical_history_entries_clinic_id_patient_id_current_key_idx`(`clinic_id`, `patient_id`, `current_key`),
    INDEX `clinical_history_entries_clinic_id_patient_id_kind_status_idx`(`clinic_id`, `patient_id`, `kind`, `status`),
    UNIQUE INDEX `clinical_history_entries_item_id_version_key`(`item_id`, `version`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `clinical_alerts` (
    `id` CHAR(36) NOT NULL,
    `clinic_id` CHAR(36) NOT NULL,
    `patient_id` CHAR(36) NOT NULL,
    `item_id` CHAR(36) NOT NULL,
    `version` INTEGER NOT NULL,
    `supersedes_id` CHAR(36) NULL,
    `current_key` CHAR(36) NULL,
    `severity` ENUM('INFO', 'WARNING', 'CRITICAL') NOT NULL,
    `text` VARCHAR(300) NOT NULL,
    `source` ENUM('PATIENT', 'GUARDIAN', 'DOCUMENT', 'PROFESSIONAL', 'OTHER') NOT NULL,
    `status` ENUM('ACTIVE', 'INACTIVE', 'ENTERED_IN_ERROR') NOT NULL DEFAULT 'ACTIVE',
    `expires_at` DATETIME(3) NULL,
    `change_kind` ENUM('CREATED', 'CORRECTED', 'RECTIFIED', 'DEACTIVATED', 'REACTIVATED', 'MARKED_IN_ERROR') NOT NULL,
    `change_reason` VARCHAR(300) NOT NULL,
    `changed_fields` JSON NULL,
    `created_by_id` CHAR(36) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `clinical_alerts_current_key_key`(`current_key`),
    INDEX `clinical_alerts_clinic_id_patient_id_current_key_idx`(`clinic_id`, `patient_id`, `current_key`),
    UNIQUE INDEX `clinical_alerts_item_id_version_key`(`item_id`, `version`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `clinical_history_entries` ADD CONSTRAINT `clinical_history_entries_patient_id_clinic_id_fkey` FOREIGN KEY (`patient_id`, `clinic_id`) REFERENCES `patients`(`id`, `clinic_id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `clinical_alerts` ADD CONSTRAINT `clinical_alerts_patient_id_clinic_id_fkey` FOREIGN KEY (`patient_id`, `clinic_id`) REFERENCES `patients`(`id`, `clinic_id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- Garantías en la base de datos: historial versionado, sin eliminación física
-- ===========================================================================

-- clinical_history_entries: cada fila es una VERSIÓN. Valida el encadenamiento al insertar.
CREATE TRIGGER `clinical_history_entries_insert_chain`
  BEFORE INSERT ON `clinical_history_entries` FOR EACH ROW
BEGIN
  IF CHAR_LENGTH(TRIM(NEW.`change_reason`)) < 3 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_history_entries: todo cambio exige un motivo de al menos 3 caracteres';
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

-- Lo único que cambia en una fila ya escrita es soltar la marca de vigente al ser reemplazada.
CREATE TRIGGER `clinical_history_entries_only_release_current`
  BEFORE UPDATE ON `clinical_history_entries` FOR EACH ROW
BEGIN
  IF OLD.`current_key` IS NULL OR NEW.`current_key` IS NOT NULL
     OR NOT (NEW.`item_id` <=> OLD.`item_id`) OR NOT (NEW.`version` <=> OLD.`version`)
     OR NOT (NEW.`patient_id` <=> OLD.`patient_id`) OR NOT (NEW.`clinic_id` <=> OLD.`clinic_id`)
     OR NOT (NEW.`status` <=> OLD.`status`) OR NOT (NEW.`change_reason` <=> OLD.`change_reason`)
     OR NOT (NEW.`change_kind` <=> OLD.`change_kind`) OR NOT (NEW.`created_by_id` <=> OLD.`created_by_id`)
     OR NOT (NEW.`created_at` <=> OLD.`created_at`) OR NOT (NEW.`supersedes_id` <=> OLD.`supersedes_id`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_history_entries: el historial es inmutable; solo se reemplaza la versión vigente';
  END IF;
END;

CREATE TRIGGER `clinical_history_entries_block_delete`
  BEFORE DELETE ON `clinical_history_entries` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_history_entries: los registros clínicos no se eliminan';
END;

-- clinical_alerts: cada fila es una VERSIÓN. Valida el encadenamiento al insertar.
CREATE TRIGGER `clinical_alerts_insert_chain`
  BEFORE INSERT ON `clinical_alerts` FOR EACH ROW
BEGIN
  IF CHAR_LENGTH(TRIM(NEW.`change_reason`)) < 3 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_alerts: todo cambio exige un motivo de al menos 3 caracteres';
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

-- Lo único que cambia en una fila ya escrita es soltar la marca de vigente al ser reemplazada.
CREATE TRIGGER `clinical_alerts_only_release_current`
  BEFORE UPDATE ON `clinical_alerts` FOR EACH ROW
BEGIN
  IF OLD.`current_key` IS NULL OR NEW.`current_key` IS NOT NULL
     OR NOT (NEW.`item_id` <=> OLD.`item_id`) OR NOT (NEW.`version` <=> OLD.`version`)
     OR NOT (NEW.`patient_id` <=> OLD.`patient_id`) OR NOT (NEW.`clinic_id` <=> OLD.`clinic_id`)
     OR NOT (NEW.`status` <=> OLD.`status`) OR NOT (NEW.`change_reason` <=> OLD.`change_reason`)
     OR NOT (NEW.`change_kind` <=> OLD.`change_kind`) OR NOT (NEW.`created_by_id` <=> OLD.`created_by_id`)
     OR NOT (NEW.`created_at` <=> OLD.`created_at`) OR NOT (NEW.`supersedes_id` <=> OLD.`supersedes_id`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_alerts: el historial es inmutable; solo se reemplaza la versión vigente';
  END IF;
END;

CREATE TRIGGER `clinical_alerts_block_delete`
  BEFORE DELETE ON `clinical_alerts` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_alerts: los registros clínicos no se eliminan';
END;
