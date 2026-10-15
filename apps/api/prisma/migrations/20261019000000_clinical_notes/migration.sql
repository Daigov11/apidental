-- CreateTable
CREATE TABLE `clinical_notes` (
    `id` CHAR(36) NOT NULL,
    `clinic_id` CHAR(36) NOT NULL,
    `patient_id` CHAR(36) NOT NULL,
    `visit_id` CHAR(36) NOT NULL,
    `item_id` CHAR(36) NOT NULL,
    `version` INTEGER NOT NULL,
    `supersedes_id` CHAR(36) NULL,
    `current_key` CHAR(36) NULL,
    `visit_key` CHAR(36) NULL,
    `status` ENUM('DRAFT', 'CLOSED', 'DISCARDED', 'ENTERED_IN_ERROR') NOT NULL,
    `body` VARCHAR(10000) NOT NULL,
    `follow_up` VARCHAR(2000) NULL,
    `revision` INTEGER NOT NULL DEFAULT 0,
    `change_kind` ENUM('CREATED', 'CLOSED', 'CORRECTED', 'RECTIFIED', 'DISCARDED', 'MARKED_IN_ERROR') NOT NULL,
    `change_reason` VARCHAR(300) NULL,
    `content_hash` CHAR(64) NULL,
    `closed_at` DATETIME(3) NULL,
    `reauth_proof_id` CHAR(36) NULL,
    `created_by_id` CHAR(36) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `clinical_notes_current_key_key`(`current_key`),
    UNIQUE INDEX `clinical_notes_visit_key_key`(`visit_key`),
    INDEX `clinical_notes_clinic_id_patient_id_current_key_idx`(`clinic_id`, `patient_id`, `current_key`),
    INDEX `clinical_notes_visit_id_current_key_idx`(`visit_id`, `current_key`),
    UNIQUE INDEX `clinical_notes_item_id_version_key`(`item_id`, `version`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `clinical_notes` ADD CONSTRAINT `clinical_notes_patient_id_clinic_id_fkey` FOREIGN KEY (`patient_id`, `clinic_id`) REFERENCES `patients`(`id`, `clinic_id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `clinical_notes` ADD CONSTRAINT `clinical_notes_visit_id_clinic_id_patient_id_fkey` FOREIGN KEY (`visit_id`, `clinic_id`, `patient_id`) REFERENCES `clinical_visits`(`id`, `clinic_id`, `patient_id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- 3.4: garantías en la base de datos para las evoluciones
-- ===========================================================================

CREATE TRIGGER `clinical_notes_insert_chain`
  BEFORE INSERT ON `clinical_notes` FOR EACH ROW
BEGIN
  DECLARE prev_status VARCHAR(20);
  IF NEW.`current_key` IS NULL OR NEW.`current_key` <> NEW.`item_id` THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_notes: una versión nueva nace como la vigente de la evolución';
  END IF;
  -- Una sola evolución activa (borrador o cerrada) por visita.
  IF (NEW.`status` IN ('DRAFT', 'CLOSED')) <> (NEW.`visit_key` IS NOT NULL) OR (NEW.`visit_key` IS NOT NULL AND NEW.`visit_key` <> NEW.`visit_id`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_notes: la clave de visita corresponde solo a la evolución activa';
  END IF;
  IF NEW.`status` = 'DRAFT' AND (NEW.`revision` <> 0 OR NEW.`content_hash` IS NOT NULL OR NEW.`closed_at` IS NOT NULL OR NEW.`reauth_proof_id` IS NOT NULL) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_notes: un borrador nace sin datos de cierre';
  END IF;
  IF NEW.`version` = 1 THEN
    IF NEW.`supersedes_id` IS NOT NULL OR NEW.`change_kind` <> 'CREATED' OR NEW.`status` <> 'DRAFT' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_notes: la versión 1 es el borrador inicial';
    END IF;
    IF (SELECT v.`status` FROM `clinical_visits` v WHERE v.`id` = NEW.`visit_id`) <> 'OPEN' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_notes: solo se redacta una evolución en una visita abierta';
    END IF;
  ELSE
    IF NEW.`change_kind` = 'CREATED' OR NEW.`supersedes_id` IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_notes: las versiones posteriores reemplazan a la anterior';
    END IF;
    SELECT p.`status` INTO prev_status FROM `clinical_notes` p
     WHERE p.`id` = NEW.`supersedes_id` AND p.`item_id` = NEW.`item_id` AND p.`version` = NEW.`version` - 1
       AND p.`patient_id` = NEW.`patient_id` AND p.`clinic_id` = NEW.`clinic_id` AND p.`visit_id` = NEW.`visit_id`;
    IF prev_status IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_notes: la versión debe continuar la anterior de la misma evolución, visita y paciente';
    END IF;
    -- Transiciones válidas: borrador -> cerrada | descartada; cerrada -> cerrada (corrección) | por error.
    IF NOT ((prev_status = 'DRAFT' AND NEW.`status` IN ('CLOSED', 'DISCARDED')) OR (prev_status = 'CLOSED' AND NEW.`status` IN ('CLOSED', 'ENTERED_IN_ERROR'))) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_notes: transición de estado no permitida';
    END IF;
    IF NEW.`change_kind` = 'CLOSED' AND prev_status <> 'DRAFT' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_notes: solo un borrador se cierra';
    END IF;
    IF NEW.`change_kind` IN ('CORRECTED', 'RECTIFIED') AND prev_status <> 'CLOSED' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_notes: solo una evolución cerrada se corrige o rectifica';
    END IF;
    IF NEW.`change_kind` <> 'CLOSED' AND CHAR_LENGTH(TRIM(COALESCE(NEW.`change_reason`, ''))) < 3 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_notes: corregir, rectificar, descartar o marcar por error exige un motivo de al menos 3 caracteres';
    END IF;
    IF NEW.`change_kind` IN ('CLOSED', 'CORRECTED', 'RECTIFIED') THEN
      IF NEW.`status` <> 'CLOSED' OR NEW.`content_hash` IS NULL OR NEW.`closed_at` IS NULL OR NEW.`reauth_proof_id` IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_notes: cerrar o corregir exige hash de integridad, fecha y reautenticación';
      END IF;
    END IF;
    IF NEW.`change_kind` = 'MARKED_IN_ERROR' AND (NEW.`status` <> 'ENTERED_IN_ERROR' OR NEW.`reauth_proof_id` IS NULL) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_notes: marcar por error exige reautenticación';
    END IF;
    IF NEW.`change_kind` = 'DISCARDED' AND NEW.`status` <> 'DISCARDED' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_notes: estado incoherente con el descarte';
    END IF;
    IF NEW.`change_kind` = 'CLOSED' AND (SELECT v.`status` FROM `clinical_visits` v WHERE v.`id` = NEW.`visit_id`) <> 'OPEN' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_notes: solo se cierra la evolución con la visita abierta';
    END IF;
  END IF;
END;

-- Dos únicas modificaciones: soltar la marca de vigente al ser reemplazada, o editar un BORRADOR en el sitio
-- (solo relato, seguimiento y contador de revisión). Una evolución cerrada nunca se edita.
CREATE TRIGGER `clinical_notes_guard_update`
  BEFORE UPDATE ON `clinical_notes` FOR EACH ROW
BEGIN
  IF NOT (NEW.`item_id` <=> OLD.`item_id`) OR NOT (NEW.`version` <=> OLD.`version`) OR NOT (NEW.`patient_id` <=> OLD.`patient_id`)
     OR NOT (NEW.`clinic_id` <=> OLD.`clinic_id`) OR NOT (NEW.`visit_id` <=> OLD.`visit_id`) OR NOT (NEW.`status` <=> OLD.`status`)
     OR NOT (NEW.`change_kind` <=> OLD.`change_kind`) OR NOT (NEW.`change_reason` <=> OLD.`change_reason`)
     OR NOT (NEW.`content_hash` <=> OLD.`content_hash`) OR NOT (NEW.`closed_at` <=> OLD.`closed_at`)
     OR NOT (NEW.`reauth_proof_id` <=> OLD.`reauth_proof_id`) OR NOT (NEW.`supersedes_id` <=> OLD.`supersedes_id`)
     OR NOT (NEW.`created_by_id` <=> OLD.`created_by_id`) OR NOT (NEW.`created_at` <=> OLD.`created_at`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_notes: la evolución es inmutable; solo se reemplaza o se edita el borrador';
  END IF;
  IF OLD.`current_key` IS NOT NULL AND NEW.`current_key` IS NULL THEN
    -- Reemplazo: se sueltan las marcas de vigente y nada del contenido cambia.
    IF NEW.`visit_key` IS NOT NULL OR NOT (NEW.`body` <=> OLD.`body`) OR NOT (NEW.`follow_up` <=> OLD.`follow_up`) OR NOT (NEW.`revision` <=> OLD.`revision`) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_notes: al reemplazarla no se modifica su contenido';
    END IF;
  ELSEIF OLD.`status` = 'DRAFT' AND OLD.`current_key` IS NOT NULL THEN
    IF NOT (NEW.`current_key` <=> OLD.`current_key`) OR NOT (NEW.`visit_key` <=> OLD.`visit_key`) OR NEW.`revision` <> OLD.`revision` + 1 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_notes: un borrador solo se edita incrementando su revisión';
    END IF;
  ELSE
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_notes: una evolución cerrada no se edita';
  END IF;
END;

CREATE TRIGGER `clinical_notes_block_delete`
  BEFORE DELETE ON `clinical_notes` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_notes: las evoluciones no se eliminan';
END;

-- La visita no se cierra con un borrador pendiente ni se cancela con evoluciones vigentes.
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
  END IF;
END;
