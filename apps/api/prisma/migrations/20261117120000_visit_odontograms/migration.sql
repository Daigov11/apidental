-- AlterTable
ALTER TABLE `reauth_proofs` MODIFY `purpose` ENUM('CLOSE_CLINICAL_NOTE', 'CORRECT_CLINICAL_NOTE', 'MARK_CLINICAL_NOTE_ERROR', 'CLINICAL_READ_ALL', 'AUTHORIZE_DIRECTOR_PROVISIONING', 'CORRECT_ODONTOGRAM', 'MARK_ODONTOGRAM_ERROR', 'CORRECT_VISIT_ODONTOGRAM') NOT NULL;

-- CreateTable
CREATE TABLE `clinical_visit_odontograms` (
    `id` CHAR(36) NOT NULL,
    `clinic_id` CHAR(36) NOT NULL,
    `patient_id` CHAR(36) NOT NULL,
    `visit_id` CHAR(36) NOT NULL,
    `phase` ENUM('DIAGNOSIS', 'POST_TREATMENT') NOT NULL,
    `version` INTEGER NOT NULL,
    `supersedes_id` CHAR(36) NULL,
    `current_key` VARCHAR(60) NULL,
    `status` ENUM('DRAFT', 'CLOSED', 'DISCARDED') NOT NULL,
    `dentition` ENUM('PERMANENT', 'PRIMARY', 'MIXED') NOT NULL,
    `data` JSON NOT NULL,
    `revision` INTEGER NOT NULL DEFAULT 0,
    `change_kind` ENUM('CREATED', 'CLOSED', 'CORRECTED', 'DISCARDED') NOT NULL,
    `change_reason` VARCHAR(300) NULL,
    `content_hash` CHAR(64) NULL,
    `closed_at` DATETIME(3) NULL,
    `reauth_proof_id` CHAR(36) NULL,
    `created_by_id` CHAR(36) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `clinical_visit_odontograms_current_key_key`(`current_key`),
    INDEX `clinical_visit_odontograms_clinic_id_patient_id_idx`(`clinic_id`, `patient_id`),
    UNIQUE INDEX `clinical_visit_odontograms_visit_id_phase_version_key`(`visit_id`, `phase`, `version`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `clinical_visit_odontograms` ADD CONSTRAINT `clinical_visit_odontograms_patient_id_clinic_id_fkey` FOREIGN KEY (`patient_id`, `clinic_id`) REFERENCES `patients`(`id`, `clinic_id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `clinical_visit_odontograms` ADD CONSTRAINT `clinical_visit_odontograms_visit_id_clinic_id_patient_id_fkey` FOREIGN KEY (`visit_id`, `clinic_id`, `patient_id`) REFERENCES `clinical_visits`(`id`, `clinic_id`, `patient_id`) ON DELETE RESTRICT ON UPDATE CASCADE;



-- ===========================================================================
-- 6.1: garantías en la base de datos para el odontograma por visita (diagnóstico y post tratamiento)
-- ===========================================================================

CREATE TRIGGER `clinical_visit_odontograms_insert_chain`
  BEFORE INSERT ON `clinical_visit_odontograms` FOR EACH ROW
BEGIN
  DECLARE prev_status VARCHAR(20);
  DECLARE visit_status VARCHAR(20);
  IF NEW.`current_key` IS NULL OR NEW.`current_key` <> CONCAT(NEW.`visit_id`, '|', NEW.`phase`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_visit_odontograms: una versión nueva nace como la vigente de la fase';
  END IF;
  IF NEW.`status` IN ('DRAFT', 'DISCARDED') AND (NEW.`revision` <> 0 OR NEW.`content_hash` IS NOT NULL OR NEW.`closed_at` IS NOT NULL OR NEW.`reauth_proof_id` IS NOT NULL) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_visit_odontograms: un borrador o descarte nace sin datos de cierre';
  END IF;
  IF NEW.`change_kind` IN ('CORRECTED', 'DISCARDED') AND CHAR_LENGTH(TRIM(COALESCE(NEW.`change_reason`, ''))) < 3 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_visit_odontograms: corregir o descartar exige un motivo de al menos 3 caracteres';
  END IF;
  SELECT v.`status` INTO visit_status FROM `clinical_visits` v
   WHERE v.`id` = NEW.`visit_id` AND v.`clinic_id` = NEW.`clinic_id` AND v.`patient_id` = NEW.`patient_id`;
  IF NEW.`status` = 'DRAFT' OR NEW.`change_kind` = 'CLOSED' THEN
    IF visit_status IS NULL OR visit_status <> 'OPEN' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_visit_odontograms: solo se redacta o guarda un odontograma con la visita abierta';
    END IF;
  END IF;
  IF NEW.`status` = 'DRAFT' AND NEW.`phase` = 'POST_TREATMENT' AND NOT EXISTS (
       SELECT 1 FROM `clinical_visit_odontograms` g WHERE g.`visit_id` = NEW.`visit_id` AND g.`phase` = 'DIAGNOSIS'
          AND g.`current_key` IS NOT NULL AND g.`status` = 'CLOSED') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_visit_odontograms: el post tratamiento parte de un diagnóstico guardado';
  END IF;
  IF NEW.`version` = 1 THEN
    IF NEW.`supersedes_id` IS NOT NULL OR NEW.`change_kind` <> 'CREATED' OR NEW.`status` <> 'DRAFT' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_visit_odontograms: la versión 1 es el borrador inicial';
    END IF;
  ELSE
    IF NEW.`supersedes_id` IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_visit_odontograms: las versiones posteriores reemplazan a la anterior';
    END IF;
    SELECT p.`status` INTO prev_status FROM `clinical_visit_odontograms` p
     WHERE p.`id` = NEW.`supersedes_id` AND p.`version` = NEW.`version` - 1 AND p.`visit_id` = NEW.`visit_id`
       AND p.`phase` = NEW.`phase` AND p.`patient_id` = NEW.`patient_id` AND p.`clinic_id` = NEW.`clinic_id`;
    IF prev_status IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_visit_odontograms: la versión debe continuar la anterior de la misma fase y visita';
    END IF;
    -- borrador -> guardado | descartado; guardado -> guardado (corrección); descartado -> borrador nuevo.
    IF NOT ((prev_status = 'DRAFT' AND NEW.`status` = 'CLOSED' AND NEW.`change_kind` = 'CLOSED')
         OR (prev_status = 'DRAFT' AND NEW.`status` = 'DISCARDED' AND NEW.`change_kind` = 'DISCARDED')
         OR (prev_status = 'CLOSED' AND NEW.`status` = 'CLOSED' AND NEW.`change_kind` = 'CORRECTED')
         OR (prev_status = 'DISCARDED' AND NEW.`status` = 'DRAFT' AND NEW.`change_kind` = 'CREATED')) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_visit_odontograms: transición de estado no permitida';
    END IF;
  END IF;
  IF NEW.`status` = 'CLOSED' AND (NEW.`content_hash` IS NULL OR NEW.`closed_at` IS NULL) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_visit_odontograms: guardar exige huella de integridad y fecha';
  END IF;
  IF NEW.`change_kind` = 'CORRECTED' AND NEW.`reauth_proof_id` IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_visit_odontograms: corregir exige reautenticación';
  END IF;
END;

-- Dos únicas modificaciones: soltar la marca de vigente al ser reemplazada, o editar un BORRADOR en el sitio
-- (contenido, dentición y contador de revisión). Una versión guardada nunca se edita.
CREATE TRIGGER `clinical_visit_odontograms_guard_update`
  BEFORE UPDATE ON `clinical_visit_odontograms` FOR EACH ROW
BEGIN
  IF NOT (NEW.`visit_id` <=> OLD.`visit_id`) OR NOT (NEW.`phase` <=> OLD.`phase`) OR NOT (NEW.`version` <=> OLD.`version`)
     OR NOT (NEW.`patient_id` <=> OLD.`patient_id`) OR NOT (NEW.`clinic_id` <=> OLD.`clinic_id`) OR NOT (NEW.`status` <=> OLD.`status`)
     OR NOT (NEW.`change_kind` <=> OLD.`change_kind`) OR NOT (NEW.`change_reason` <=> OLD.`change_reason`)
     OR NOT (NEW.`content_hash` <=> OLD.`content_hash`) OR NOT (NEW.`closed_at` <=> OLD.`closed_at`)
     OR NOT (NEW.`reauth_proof_id` <=> OLD.`reauth_proof_id`) OR NOT (NEW.`supersedes_id` <=> OLD.`supersedes_id`)
     OR NOT (NEW.`created_by_id` <=> OLD.`created_by_id`) OR NOT (NEW.`created_at` <=> OLD.`created_at`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_visit_odontograms: el odontograma es inmutable; solo se reemplaza o se edita el borrador';
  END IF;
  IF OLD.`current_key` IS NOT NULL AND NEW.`current_key` IS NULL THEN
    IF NOT (NEW.`data` <=> OLD.`data`) OR NOT (NEW.`dentition` <=> OLD.`dentition`) OR NOT (NEW.`revision` <=> OLD.`revision`) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_visit_odontograms: al reemplazarlo no se modifica su contenido';
    END IF;
  ELSEIF OLD.`status` = 'DRAFT' AND OLD.`current_key` IS NOT NULL THEN
    IF NOT (NEW.`current_key` <=> OLD.`current_key`) OR NEW.`revision` <> OLD.`revision` + 1 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_visit_odontograms: un borrador solo se edita incrementando su revisión';
    END IF;
  ELSE
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_visit_odontograms: una versión guardada no se edita';
  END IF;
END;

CREATE TRIGGER `clinical_visit_odontograms_block_delete`
  BEFORE DELETE ON `clinical_visit_odontograms` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_visit_odontograms: los odontogramas no se eliminan';
END;

-- La visita no se cierra con un odontograma en borrador ni se cancela con odontogramas vigentes.
DROP TRIGGER `clinical_visits_guard_update`;

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
    IF EXISTS (SELECT 1 FROM `clinical_notes` n WHERE n.`visit_id` = NEW.`id` AND n.`current_key` IS NOT NULL AND n.`status` = 'DRAFT') THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_visits: no se cierra una visita con una evolución en borrador';
    END IF;
    IF EXISTS (SELECT 1 FROM `clinical_visit_odontograms` o WHERE o.`visit_id` = NEW.`id` AND o.`current_key` IS NOT NULL AND o.`status` = 'DRAFT') THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_visits: no se cierra una visita con un odontograma en borrador';
    END IF;
  ELSE
    IF NEW.`closed_at` IS NOT NULL OR NEW.`cancel_reason` IS NULL OR CHAR_LENGTH(TRIM(NEW.`cancel_reason`)) < 3 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_visits: cancelar exige un motivo de al menos 3 caracteres';
    END IF;
    IF EXISTS (SELECT 1 FROM `clinical_procedures` p WHERE p.`visit_id` = NEW.`id` AND p.`current_key` IS NOT NULL AND p.`status` IN ('OPEN', 'CLOSED')) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_visits: no se cancela una visita con procedimientos vigentes';
    END IF;
    IF EXISTS (SELECT 1 FROM `clinical_notes` n WHERE n.`visit_id` = NEW.`id` AND n.`current_key` IS NOT NULL AND n.`status` IN ('DRAFT', 'CLOSED')) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_visits: no se cancela una visita con evoluciones vigentes';
    END IF;
    IF EXISTS (SELECT 1 FROM `clinical_visit_odontograms` o WHERE o.`visit_id` = NEW.`id` AND o.`current_key` IS NOT NULL AND o.`status` IN ('DRAFT', 'CLOSED')) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_visits: no se cancela una visita con odontogramas vigentes';
    END IF;
  END IF;
END;
