-- CreateTable
CREATE TABLE `procedure_definitions` (
    `id` CHAR(36) NOT NULL,
    `clinic_id` CHAR(36) NOT NULL,
    `code` VARCHAR(40) NOT NULL,
    `name` VARCHAR(160) NOT NULL,
    `description` VARCHAR(300) NULL,
    `requires_clinical_consent` BOOLEAN NOT NULL DEFAULT false,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_by_id` CHAR(36) NOT NULL,
    `updated_by_id` CHAR(36) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `procedure_definitions_clinic_id_code_key`(`clinic_id`, `code`),
    UNIQUE INDEX `procedure_definitions_id_clinic_id_key`(`id`, `clinic_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `clinical_visits` (
    `id` CHAR(36) NOT NULL,
    `clinic_id` CHAR(36) NOT NULL,
    `patient_id` CHAR(36) NOT NULL,
    `branch_id` CHAR(36) NOT NULL,
    `dentist_user_id` CHAR(36) NOT NULL,
    `care_relationship_id` CHAR(36) NOT NULL,
    `visit_number` INTEGER NOT NULL,
    `status` ENUM('OPEN', 'CLOSED', 'CANCELLED') NOT NULL DEFAULT 'OPEN',
    `open_key` VARCHAR(80) NULL,
    `reason` VARCHAR(300) NULL,
    `started_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `closed_at` DATETIME(3) NULL,
    `cancel_reason` VARCHAR(300) NULL,
    `appointment_id` CHAR(36) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_by_id` CHAR(36) NOT NULL,

    UNIQUE INDEX `clinical_visits_open_key_key`(`open_key`),
    INDEX `clinical_visits_clinic_id_patient_id_status_idx`(`clinic_id`, `patient_id`, `status`),
    INDEX `clinical_visits_dentist_user_id_status_idx`(`dentist_user_id`, `status`),
    UNIQUE INDEX `clinical_visits_patient_id_visit_number_key`(`patient_id`, `visit_number`),
    UNIQUE INDEX `clinical_visits_id_clinic_id_patient_id_key`(`id`, `clinic_id`, `patient_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `clinical_diagnoses` (
    `id` CHAR(36) NOT NULL,
    `clinic_id` CHAR(36) NOT NULL,
    `patient_id` CHAR(36) NOT NULL,
    `visit_id` CHAR(36) NOT NULL,
    `item_id` CHAR(36) NOT NULL,
    `version` INTEGER NOT NULL,
    `supersedes_id` CHAR(36) NULL,
    `current_key` CHAR(36) NULL,
    `description` VARCHAR(500) NOT NULL,
    `code` VARCHAR(40) NULL,
    `certainty` ENUM('PRESUMPTIVE', 'DEFINITIVE') NOT NULL,
    `status` ENUM('ACTIVE', 'INACTIVE', 'ENTERED_IN_ERROR') NOT NULL DEFAULT 'ACTIVE',
    `change_kind` ENUM('CREATED', 'CORRECTED', 'RECTIFIED', 'DEACTIVATED', 'REACTIVATED', 'MARKED_IN_ERROR') NOT NULL,
    `change_reason` VARCHAR(300) NULL,
    `changed_fields` JSON NULL,
    `created_by_id` CHAR(36) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `clinical_diagnoses_current_key_key`(`current_key`),
    INDEX `clinical_diagnoses_clinic_id_patient_id_current_key_idx`(`clinic_id`, `patient_id`, `current_key`),
    INDEX `clinical_diagnoses_visit_id_current_key_idx`(`visit_id`, `current_key`),
    UNIQUE INDEX `clinical_diagnoses_item_id_version_key`(`item_id`, `version`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `clinical_procedures` (
    `id` CHAR(36) NOT NULL,
    `clinic_id` CHAR(36) NOT NULL,
    `patient_id` CHAR(36) NOT NULL,
    `visit_id` CHAR(36) NOT NULL,
    `item_id` CHAR(36) NOT NULL,
    `version` INTEGER NOT NULL,
    `supersedes_id` CHAR(36) NULL,
    `current_key` CHAR(36) NULL,
    `definition_id` CHAR(36) NOT NULL,
    `definition_code` VARCHAR(40) NOT NULL,
    `definition_name` VARCHAR(160) NOT NULL,
    `dentist_user_id` CHAR(36) NOT NULL,
    `notes` VARCHAR(1000) NULL,
    `performed_at` DATETIME(3) NOT NULL,
    `status` ENUM('OPEN', 'CLOSED', 'CANCELLED', 'ENTERED_IN_ERROR') NOT NULL DEFAULT 'OPEN',
    `closed_at` DATETIME(3) NULL,
    `closure_consent` ENUM('NOT_REQUIRED', 'GRANTED') NULL,
    `change_kind` ENUM('CREATED', 'CORRECTED', 'RECTIFIED', 'CLOSED', 'CANCELLED', 'MARKED_IN_ERROR') NOT NULL,
    `change_reason` VARCHAR(300) NULL,
    `changed_fields` JSON NULL,
    `created_by_id` CHAR(36) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `clinical_procedures_current_key_key`(`current_key`),
    INDEX `clinical_procedures_clinic_id_patient_id_current_key_idx`(`clinic_id`, `patient_id`, `current_key`),
    INDEX `clinical_procedures_visit_id_current_key_idx`(`visit_id`, `current_key`),
    UNIQUE INDEX `clinical_procedures_item_id_version_key`(`item_id`, `version`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `procedure_definitions` ADD CONSTRAINT `procedure_definitions_clinic_id_fkey` FOREIGN KEY (`clinic_id`) REFERENCES `clinics`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `clinical_visits` ADD CONSTRAINT `clinical_visits_patient_id_clinic_id_fkey` FOREIGN KEY (`patient_id`, `clinic_id`) REFERENCES `patients`(`id`, `clinic_id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `clinical_visits` ADD CONSTRAINT `clinical_visits_branch_id_clinic_id_fkey` FOREIGN KEY (`branch_id`, `clinic_id`) REFERENCES `branches`(`id`, `clinic_id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `clinical_visits` ADD CONSTRAINT `clinical_visits_dentist_user_id_fkey` FOREIGN KEY (`dentist_user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `clinical_diagnoses` ADD CONSTRAINT `clinical_diagnoses_patient_id_clinic_id_fkey` FOREIGN KEY (`patient_id`, `clinic_id`) REFERENCES `patients`(`id`, `clinic_id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `clinical_diagnoses` ADD CONSTRAINT `clinical_diagnoses_visit_id_clinic_id_patient_id_fkey` FOREIGN KEY (`visit_id`, `clinic_id`, `patient_id`) REFERENCES `clinical_visits`(`id`, `clinic_id`, `patient_id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `clinical_procedures` ADD CONSTRAINT `clinical_procedures_patient_id_clinic_id_fkey` FOREIGN KEY (`patient_id`, `clinic_id`) REFERENCES `patients`(`id`, `clinic_id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `clinical_procedures` ADD CONSTRAINT `clinical_procedures_visit_id_clinic_id_patient_id_fkey` FOREIGN KEY (`visit_id`, `clinic_id`, `patient_id`) REFERENCES `clinical_visits`(`id`, `clinic_id`, `patient_id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `clinical_procedures` ADD CONSTRAINT `clinical_procedures_definition_id_clinic_id_fkey` FOREIGN KEY (`definition_id`, `clinic_id`) REFERENCES `procedure_definitions`(`id`, `clinic_id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- 3.3: garantías en la base de datos (catálogo, visitas, diagnósticos y procedimientos)
-- ===========================================================================

-- Catálogo de procedimientos: el código y la clínica no cambian; cada cambio sube la versión; no se borra.
CREATE TRIGGER `procedure_definitions_guard_update`
  BEFORE UPDATE ON `procedure_definitions` FOR EACH ROW
BEGIN
  IF NOT (NEW.`code` <=> OLD.`code`) OR NOT (NEW.`clinic_id` <=> OLD.`clinic_id`)
     OR NOT (NEW.`created_by_id` <=> OLD.`created_by_id`) OR NOT (NEW.`created_at` <=> OLD.`created_at`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'procedure_definitions: el código y la clínica son inmutables';
  END IF;
  IF NEW.`version` <> OLD.`version` + 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'procedure_definitions: cada cambio incrementa la versión en uno';
  END IF;
END;

CREATE TRIGGER `procedure_definitions_block_delete`
  BEFORE DELETE ON `procedure_definitions` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'procedure_definitions: el catálogo no se elimina; se desactiva';
END;

-- Visita: nace abierta; su núcleo es inmutable; solo pasa de OPEN a CLOSED o CANCELLED, una vez.
CREATE TRIGGER `clinical_visits_insert_open`
  BEFORE INSERT ON `clinical_visits` FOR EACH ROW
BEGIN
  IF NEW.`status` <> 'OPEN' OR NEW.`open_key` IS NULL OR NEW.`closed_at` IS NOT NULL OR NEW.`cancel_reason` IS NOT NULL OR NEW.`version` <> 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_visits: una visita nace abierta, en versión 1 y sin datos de cierre';
  END IF;
END;

CREATE TRIGGER `clinical_visits_guard_update`
  BEFORE UPDATE ON `clinical_visits` FOR EACH ROW
BEGIN
  IF NOT (NEW.`clinic_id` <=> OLD.`clinic_id`) OR NOT (NEW.`patient_id` <=> OLD.`patient_id`)
     OR NOT (NEW.`branch_id` <=> OLD.`branch_id`) OR NOT (NEW.`dentist_user_id` <=> OLD.`dentist_user_id`)
     OR NOT (NEW.`care_relationship_id` <=> OLD.`care_relationship_id`) OR NOT (NEW.`visit_number` <=> OLD.`visit_number`)
     OR NOT (NEW.`reason` <=> OLD.`reason`) OR NOT (NEW.`started_at` <=> OLD.`started_at`)
     OR NOT (NEW.`appointment_id` <=> OLD.`appointment_id`) OR NOT (NEW.`created_by_id` <=> OLD.`created_by_id`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_visits: paciente, sede, odontólogo, relación, número y motivo son inmutables';
  END IF;
  IF OLD.`status` <> 'OPEN' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_visits: una visita cerrada o cancelada no se modifica';
  END IF;
  IF NEW.`status` NOT IN ('CLOSED', 'CANCELLED') OR NEW.`open_key` IS NOT NULL OR NEW.`version` <> OLD.`version` + 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_visits: la única modificación permitida es cerrarla o cancelarla';
  END IF;
  IF NEW.`status` = 'CLOSED' THEN
    IF NEW.`closed_at` IS NULL OR NEW.`cancel_reason` IS NOT NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_visits: cerrar exige fecha de cierre';
    END IF;
    IF EXISTS (SELECT 1 FROM `clinical_procedures` p WHERE p.`visit_id` = NEW.`id` AND p.`current_key` IS NOT NULL AND p.`status` = 'OPEN') THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_visits: no se cierra una visita con procedimientos abiertos';
    END IF;
  ELSE
    IF NEW.`closed_at` IS NOT NULL OR NEW.`cancel_reason` IS NULL OR CHAR_LENGTH(TRIM(NEW.`cancel_reason`)) < 3 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_visits: cancelar exige un motivo de al menos 3 caracteres';
    END IF;
    IF EXISTS (SELECT 1 FROM `clinical_procedures` p WHERE p.`visit_id` = NEW.`id` AND p.`current_key` IS NOT NULL AND p.`status` IN ('OPEN', 'CLOSED')) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_visits: no se cancela una visita con procedimientos vigentes';
    END IF;
  END IF;
END;

CREATE TRIGGER `clinical_visits_block_delete`
  BEFORE DELETE ON `clinical_visits` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_visits: las visitas no se eliminan';
END;

CREATE TRIGGER `clinical_diagnoses_insert_chain`
  BEFORE INSERT ON `clinical_diagnoses` FOR EACH ROW
BEGIN
  IF NEW.`version` > 1 AND CHAR_LENGTH(TRIM(COALESCE(NEW.`change_reason`, ''))) < 3 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_diagnoses: todo cambio posterior al alta exige un motivo de al menos 3 caracteres';
  END IF;
  IF NEW.`version` = 1 AND NEW.`change_reason` IS NOT NULL AND CHAR_LENGTH(TRIM(NEW.`change_reason`)) < 3 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_diagnoses: si se informa un motivo debe tener al menos 3 caracteres';
  END IF;
  IF NEW.`current_key` IS NULL OR NEW.`current_key` <> NEW.`item_id` THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_diagnoses: una versión nueva nace como la vigente del elemento';
  END IF;
  IF NEW.`version` = 1 THEN
    IF NEW.`supersedes_id` IS NOT NULL OR NEW.`change_kind` <> 'CREATED' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_diagnoses: la versión 1 es el alta del elemento';
    END IF;
    IF (SELECT v.`status` FROM `clinical_visits` v WHERE v.`id` = NEW.`visit_id`) <> 'OPEN' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_diagnoses: solo se registran elementos nuevos en una visita abierta';
    END IF;
  ELSE
    IF NEW.`change_kind` = 'CREATED' OR NEW.`supersedes_id` IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_diagnoses: las versiones posteriores reemplazan a la anterior';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM `clinical_diagnoses` p
      WHERE p.`id` = NEW.`supersedes_id` AND p.`item_id` = NEW.`item_id` AND p.`version` = NEW.`version` - 1
        AND p.`patient_id` = NEW.`patient_id` AND p.`clinic_id` = NEW.`clinic_id` AND p.`visit_id` = NEW.`visit_id`
    ) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_diagnoses: la versión debe continuar la anterior del mismo elemento, visita y paciente';
    END IF;
  END IF;
END;

CREATE TRIGGER `clinical_diagnoses_only_release_current`
  BEFORE UPDATE ON `clinical_diagnoses` FOR EACH ROW
BEGIN
  IF OLD.`current_key` IS NULL OR NEW.`current_key` IS NOT NULL
     OR NOT (NEW.`item_id` <=> OLD.`item_id`) OR NOT (NEW.`version` <=> OLD.`version`)
     OR NOT (NEW.`patient_id` <=> OLD.`patient_id`) OR NOT (NEW.`clinic_id` <=> OLD.`clinic_id`)
     OR NOT (NEW.`visit_id` <=> OLD.`visit_id`) OR NOT (NEW.`status` <=> OLD.`status`)
     OR NOT (NEW.`change_reason` <=> OLD.`change_reason`) OR NOT (NEW.`change_kind` <=> OLD.`change_kind`)
     OR NOT (NEW.`created_by_id` <=> OLD.`created_by_id`) OR NOT (NEW.`created_at` <=> OLD.`created_at`)
     OR NOT (NEW.`supersedes_id` <=> OLD.`supersedes_id`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_diagnoses: el historial es inmutable; solo se reemplaza la versión vigente';
  END IF;
END;

CREATE TRIGGER `clinical_diagnoses_block_delete`
  BEFORE DELETE ON `clinical_diagnoses` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_diagnoses: los registros clínicos no se eliminan';
END;

CREATE TRIGGER `clinical_procedures_insert_chain`
  BEFORE INSERT ON `clinical_procedures` FOR EACH ROW
BEGIN
  IF NEW.`version` > 1 AND CHAR_LENGTH(TRIM(COALESCE(NEW.`change_reason`, ''))) < 3 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_procedures: todo cambio posterior al alta exige un motivo de al menos 3 caracteres';
  END IF;
  IF NEW.`version` = 1 AND NEW.`change_reason` IS NOT NULL AND CHAR_LENGTH(TRIM(NEW.`change_reason`)) < 3 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_procedures: si se informa un motivo debe tener al menos 3 caracteres';
  END IF;
  IF NEW.`current_key` IS NULL OR NEW.`current_key` <> NEW.`item_id` THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_procedures: una versión nueva nace como la vigente del elemento';
  END IF;
  IF NEW.`version` = 1 THEN
    IF NEW.`supersedes_id` IS NOT NULL OR NEW.`change_kind` <> 'CREATED' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_procedures: la versión 1 es el alta del elemento';
    END IF;
    IF (SELECT v.`status` FROM `clinical_visits` v WHERE v.`id` = NEW.`visit_id`) <> 'OPEN' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_procedures: solo se registran elementos nuevos en una visita abierta';
    END IF;
  ELSE
    IF NEW.`change_kind` = 'CREATED' OR NEW.`supersedes_id` IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_procedures: las versiones posteriores reemplazan a la anterior';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM `clinical_procedures` p
      WHERE p.`id` = NEW.`supersedes_id` AND p.`item_id` = NEW.`item_id` AND p.`version` = NEW.`version` - 1
        AND p.`patient_id` = NEW.`patient_id` AND p.`clinic_id` = NEW.`clinic_id` AND p.`visit_id` = NEW.`visit_id` AND p.`definition_id` = NEW.`definition_id` AND p.`dentist_user_id` = NEW.`dentist_user_id` AND p.`definition_code` = NEW.`definition_code`
    ) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_procedures: la versión debe continuar la anterior del mismo elemento, visita y paciente';
    END IF;
  END IF;
  IF NEW.`change_kind` = 'CREATED' AND (NEW.`status` <> 'OPEN' OR NEW.`closed_at` IS NOT NULL OR NEW.`closure_consent` IS NOT NULL) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_procedures: un procedimiento nace abierto';
  END IF;
  IF NEW.`change_kind` = 'CLOSED' THEN
    IF NEW.`status` <> 'CLOSED' OR NEW.`closed_at` IS NULL OR NEW.`closure_consent` IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_procedures: cerrar exige fecha y el consentimiento verificado';
    END IF;
    IF (SELECT v.`status` FROM `clinical_visits` v WHERE v.`id` = NEW.`visit_id`) <> 'OPEN' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_procedures: solo se cierra un procedimiento en una visita abierta';
    END IF;
    -- Consentimiento clínico: si el catálogo lo exige, debe haber uno vigente (defensa en profundidad).
    IF (SELECT d.`requires_clinical_consent` FROM `procedure_definitions` d WHERE d.`id` = NEW.`definition_id`) = 1
       AND NOT EXISTS (SELECT 1 FROM `patient_consents` c WHERE c.`patient_id` = NEW.`patient_id` AND c.`clinic_id` = NEW.`clinic_id` AND c.`type` = 'CLINICAL' AND c.`status` = 'GRANTED') THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_procedures: el procedimiento requiere consentimiento clínico vigente';
    END IF;
  END IF;
  IF NEW.`change_kind` = 'CANCELLED' AND NEW.`status` <> 'CANCELLED' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_procedures: estado incoherente con la cancelación';
  END IF;
  IF NEW.`change_kind` = 'MARKED_IN_ERROR' AND NEW.`status` <> 'ENTERED_IN_ERROR' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_procedures: estado incoherente con el registro por error';
  END IF;
END;

CREATE TRIGGER `clinical_procedures_only_release_current`
  BEFORE UPDATE ON `clinical_procedures` FOR EACH ROW
BEGIN
  IF OLD.`current_key` IS NULL OR NEW.`current_key` IS NOT NULL
     OR NOT (NEW.`item_id` <=> OLD.`item_id`) OR NOT (NEW.`version` <=> OLD.`version`)
     OR NOT (NEW.`patient_id` <=> OLD.`patient_id`) OR NOT (NEW.`clinic_id` <=> OLD.`clinic_id`)
     OR NOT (NEW.`visit_id` <=> OLD.`visit_id`) OR NOT (NEW.`status` <=> OLD.`status`)
     OR NOT (NEW.`change_reason` <=> OLD.`change_reason`) OR NOT (NEW.`change_kind` <=> OLD.`change_kind`)
     OR NOT (NEW.`created_by_id` <=> OLD.`created_by_id`) OR NOT (NEW.`created_at` <=> OLD.`created_at`)
     OR NOT (NEW.`supersedes_id` <=> OLD.`supersedes_id`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_procedures: el historial es inmutable; solo se reemplaza la versión vigente';
  END IF;
END;

CREATE TRIGGER `clinical_procedures_block_delete`
  BEFORE DELETE ON `clinical_procedures` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_procedures: los registros clínicos no se eliminan';
END;
