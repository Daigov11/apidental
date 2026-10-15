-- AlterTable
ALTER TABLE `reauth_proofs` MODIFY `purpose` ENUM('CLOSE_CLINICAL_NOTE', 'CORRECT_CLINICAL_NOTE', 'MARK_CLINICAL_NOTE_ERROR', 'CLINICAL_READ_ALL', 'AUTHORIZE_DIRECTOR_PROVISIONING', 'CORRECT_ODONTOGRAM', 'MARK_ODONTOGRAM_ERROR') NOT NULL;

-- CreateTable
CREATE TABLE `clinical_odontograms` (
    `id` CHAR(36) NOT NULL,
    `clinic_id` CHAR(36) NOT NULL,
    `patient_id` CHAR(36) NOT NULL,
    `version` INTEGER NOT NULL,
    `supersedes_id` CHAR(36) NULL,
    `current_key` CHAR(36) NULL,
    `status` ENUM('DRAFT', 'CLOSED', 'DISCARDED', 'ENTERED_IN_ERROR') NOT NULL,
    `dentition` ENUM('PERMANENT', 'PRIMARY', 'MIXED') NOT NULL,
    `data` JSON NOT NULL,
    `revision` INTEGER NOT NULL DEFAULT 0,
    `change_kind` ENUM('CREATED', 'UPDATED', 'CORRECTED', 'RECTIFIED', 'DISCARDED', 'MARKED_IN_ERROR') NOT NULL,
    `change_reason` VARCHAR(300) NULL,
    `content_hash` CHAR(64) NULL,
    `closed_at` DATETIME(3) NULL,
    `reauth_proof_id` CHAR(36) NULL,
    `created_by_id` CHAR(36) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `clinical_odontograms_current_key_key`(`current_key`),
    INDEX `clinical_odontograms_clinic_id_patient_id_idx`(`clinic_id`, `patient_id`),
    UNIQUE INDEX `clinical_odontograms_patient_id_version_key`(`patient_id`, `version`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `clinical_odontograms` ADD CONSTRAINT `clinical_odontograms_patient_id_clinic_id_fkey` FOREIGN KEY (`patient_id`, `clinic_id`) REFERENCES `patients`(`id`, `clinic_id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- 3.5: garantías en la base de datos para el odontograma versionado
-- ===========================================================================

CREATE TRIGGER `clinical_odontograms_insert_chain`
  BEFORE INSERT ON `clinical_odontograms` FOR EACH ROW
BEGIN
  DECLARE prev_status VARCHAR(20);
  DECLARE prev_kind VARCHAR(20);
  IF NEW.`current_key` IS NULL OR NEW.`current_key` <> NEW.`patient_id` THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_odontograms: una versión nueva nace como la vigente de la cadena del paciente';
  END IF;
  IF NEW.`status` = 'DRAFT' AND (NEW.`revision` <> 0 OR NEW.`content_hash` IS NOT NULL OR NEW.`closed_at` IS NOT NULL OR NEW.`reauth_proof_id` IS NOT NULL) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_odontograms: un borrador nace sin datos de cierre';
  END IF;
  -- motivo: obligatorio al corregir, rectificar, descartar o marcar por error; opcional en el alta y en la actualización.
  IF NEW.`change_kind` IN ('CORRECTED', 'RECTIFIED', 'DISCARDED', 'MARKED_IN_ERROR') AND CHAR_LENGTH(TRIM(COALESCE(NEW.`change_reason`, ''))) < 3 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_odontograms: corregir, rectificar, descartar o marcar por error exige un motivo de al menos 3 caracteres';
  END IF;
  IF NEW.`change_reason` IS NOT NULL AND CHAR_LENGTH(TRIM(NEW.`change_reason`)) < 3 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_odontograms: si se informa un motivo debe tener al menos 3 caracteres';
  END IF;
  IF NEW.`version` = 1 THEN
    IF NEW.`supersedes_id` IS NOT NULL OR NEW.`change_kind` <> 'CREATED' OR NEW.`status` <> 'DRAFT' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_odontograms: la versión 1 es el borrador inicial';
    END IF;
  ELSE
    IF NEW.`supersedes_id` IS NULL OR NEW.`change_kind` = 'CREATED' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_odontograms: las versiones posteriores reemplazan a la anterior';
    END IF;
    SELECT p.`status`, p.`change_kind` INTO prev_status, prev_kind FROM `clinical_odontograms` p
     WHERE p.`id` = NEW.`supersedes_id` AND p.`version` = NEW.`version` - 1 AND p.`patient_id` = NEW.`patient_id` AND p.`clinic_id` = NEW.`clinic_id`;
    IF prev_status IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_odontograms: la versión debe continuar la anterior del mismo paciente';
    END IF;
    -- borrador -> guardada | descartada; guardada -> borrador nuevo | por error; descartada o por error -> borrador nuevo.
    IF NOT ((prev_status = 'DRAFT' AND NEW.`status` IN ('CLOSED', 'DISCARDED'))
         OR (prev_status = 'CLOSED' AND NEW.`status` IN ('DRAFT', 'ENTERED_IN_ERROR'))
         OR (prev_status IN ('DISCARDED', 'ENTERED_IN_ERROR') AND NEW.`status` = 'DRAFT')) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_odontograms: transición de estado no permitida';
    END IF;
    IF NEW.`status` = 'DRAFT' AND NEW.`change_kind` NOT IN ('UPDATED', 'CORRECTED', 'RECTIFIED') THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_odontograms: un borrador nuevo es una actualización, corrección o rectificación';
    END IF;
    IF NEW.`status` = 'CLOSED' AND (NEW.`change_kind` <> prev_kind OR NEW.`content_hash` IS NULL OR NEW.`closed_at` IS NULL) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_odontograms: guardar la versión conserva el tipo del borrador y exige huella de integridad y fecha';
    END IF;
    -- Corregir o rectificar exige reautenticación al guardar la versión; marcar por error, también.
    IF NEW.`status` = 'CLOSED' AND NEW.`change_kind` IN ('CORRECTED', 'RECTIFIED') AND NEW.`reauth_proof_id` IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_odontograms: corregir o rectificar exige reautenticación';
    END IF;
    IF NEW.`status` = 'ENTERED_IN_ERROR' AND (NEW.`change_kind` <> 'MARKED_IN_ERROR' OR NEW.`reauth_proof_id` IS NULL) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_odontograms: marcar por error exige reautenticación';
    END IF;
    IF NEW.`status` = 'DISCARDED' AND NEW.`change_kind` <> 'DISCARDED' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_odontograms: estado incoherente con el descarte';
    END IF;
  END IF;
END;

-- Dos únicas modificaciones: soltar la marca de vigente al ser reemplazada, o editar un BORRADOR vigente en el sitio
-- (solo estructura, dentición y contador de revisión). Una versión guardada nunca se edita.
CREATE TRIGGER `clinical_odontograms_guard_update`
  BEFORE UPDATE ON `clinical_odontograms` FOR EACH ROW
BEGIN
  IF NOT (NEW.`version` <=> OLD.`version`) OR NOT (NEW.`patient_id` <=> OLD.`patient_id`) OR NOT (NEW.`clinic_id` <=> OLD.`clinic_id`)
     OR NOT (NEW.`status` <=> OLD.`status`) OR NOT (NEW.`change_kind` <=> OLD.`change_kind`) OR NOT (NEW.`change_reason` <=> OLD.`change_reason`)
     OR NOT (NEW.`content_hash` <=> OLD.`content_hash`) OR NOT (NEW.`closed_at` <=> OLD.`closed_at`) OR NOT (NEW.`reauth_proof_id` <=> OLD.`reauth_proof_id`)
     OR NOT (NEW.`supersedes_id` <=> OLD.`supersedes_id`) OR NOT (NEW.`created_by_id` <=> OLD.`created_by_id`) OR NOT (NEW.`created_at` <=> OLD.`created_at`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_odontograms: la versión es inmutable; solo se reemplaza o se edita el borrador';
  END IF;
  IF OLD.`current_key` IS NOT NULL AND NEW.`current_key` IS NULL THEN
    IF NOT (NEW.`data` <=> OLD.`data`) OR NOT (NEW.`dentition` <=> OLD.`dentition`) OR NOT (NEW.`revision` <=> OLD.`revision`) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_odontograms: al reemplazarla no se modifica su contenido';
    END IF;
  ELSEIF OLD.`status` = 'DRAFT' AND OLD.`current_key` IS NOT NULL THEN
    IF NOT (NEW.`current_key` <=> OLD.`current_key`) OR NEW.`revision` <> OLD.`revision` + 1 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_odontograms: un borrador solo se edita incrementando su revisión';
    END IF;
  ELSE
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_odontograms: una versión guardada no se edita';
  END IF;
END;

CREATE TRIGGER `clinical_odontograms_block_delete`
  BEFORE DELETE ON `clinical_odontograms` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_odontograms: los odontogramas no se eliminan';
END;
