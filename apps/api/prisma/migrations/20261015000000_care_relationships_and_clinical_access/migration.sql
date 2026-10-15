-- AlterTable
ALTER TABLE `user_assignments` ADD COLUMN `granted_by_id` CHAR(36) NULL;

-- CreateTable
CREATE TABLE `patient_care_relationships` (
    `id` CHAR(36) NOT NULL,
    `clinic_id` CHAR(36) NOT NULL,
    `patient_id` CHAR(36) NOT NULL,
    `dentist_user_id` CHAR(36) NOT NULL,
    `branch_id` CHAR(36) NULL,
    `source` ENUM('ASSIGNMENT', 'APPOINTMENT', 'VISIT') NOT NULL,
    `source_ref` VARCHAR(36) NULL,
    `status` ENUM('ACTIVE', 'ENDED') NOT NULL DEFAULT 'ACTIVE',
    `active_key` VARCHAR(120) NULL,
    `started_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `valid_until` DATETIME(3) NULL,
    `reason` VARCHAR(300) NULL,
    `created_by_id` CHAR(36) NOT NULL,
    `ended_at` DATETIME(3) NULL,
    `ended_by_id` CHAR(36) NULL,
    `end_kind` ENUM('REVOKED', 'EXPIRED', 'SYSTEM') NULL,
    `end_reason` VARCHAR(300) NULL,

    UNIQUE INDEX `patient_care_relationships_active_key_key`(`active_key`),
    INDEX `patient_care_relationships_clinic_id_patient_id_status_idx`(`clinic_id`, `patient_id`, `status`),
    INDEX `patient_care_relationships_dentist_user_id_status_idx`(`dentist_user_id`, `status`),
    INDEX `patient_care_relationships_clinic_id_status_valid_until_idx`(`clinic_id`, `status`, `valid_until`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `clinical_access_grants` (
    `id` CHAR(36) NOT NULL,
    `clinic_id` CHAR(36) NOT NULL,
    `patient_id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `session_id` CHAR(36) NOT NULL,
    `category` ENUM('CONTINUITY_OF_CARE', 'QUALITY_AUDIT', 'LEGAL_REQUEST', 'OTHER') NOT NULL,
    `reason` VARCHAR(500) NOT NULL,
    `granted_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expires_at` DATETIME(3) NOT NULL,
    `ip` VARCHAR(64) NULL,
    `user_agent` VARCHAR(255) NULL,

    INDEX `clinical_access_grants_user_id_patient_id_expires_at_idx`(`user_id`, `patient_id`, `expires_at`),
    INDEX `clinical_access_grants_clinic_id_granted_at_idx`(`clinic_id`, `granted_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `patient_care_relationships` ADD CONSTRAINT `patient_care_relationships_patient_id_clinic_id_fkey` FOREIGN KEY (`patient_id`, `clinic_id`) REFERENCES `patients`(`id`, `clinic_id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `patient_care_relationships` ADD CONSTRAINT `patient_care_relationships_branch_id_clinic_id_fkey` FOREIGN KEY (`branch_id`, `clinic_id`) REFERENCES `branches`(`id`, `clinic_id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `patient_care_relationships` ADD CONSTRAINT `patient_care_relationships_dentist_user_id_fkey` FOREIGN KEY (`dentist_user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `clinical_access_grants` ADD CONSTRAINT `clinical_access_grants_patient_id_clinic_id_fkey` FOREIGN KEY (`patient_id`, `clinic_id`) REFERENCES `patients`(`id`, `clinic_id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `clinical_access_grants` ADD CONSTRAINT `clinical_access_grants_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- Garantías en la base de datos (defensa en profundidad; la aplicación aplica las mismas reglas)
-- ===========================================================================

-- Relación asistencial: nace ACTIVA y vigente; su contenido no cambia; solo puede TERMINAR (una vez, con
-- motivo) y nunca se borra ni se reabre.
CREATE TRIGGER `care_relationships_insert_active`
  BEFORE INSERT ON `patient_care_relationships` FOR EACH ROW
BEGIN
  IF NEW.`status` <> 'ACTIVE' OR NEW.`active_key` IS NULL
     OR NEW.`ended_at` IS NOT NULL OR NEW.`ended_by_id` IS NOT NULL OR NEW.`end_kind` IS NOT NULL OR NEW.`end_reason` IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'patient_care_relationships: una relación nace activa y sin datos de cierre';
  END IF;
END;

CREATE TRIGGER `care_relationships_immutable_core`
  BEFORE UPDATE ON `patient_care_relationships` FOR EACH ROW
BEGIN
  IF NOT (NEW.`clinic_id` <=> OLD.`clinic_id`)
     OR NOT (NEW.`patient_id` <=> OLD.`patient_id`)
     OR NOT (NEW.`dentist_user_id` <=> OLD.`dentist_user_id`)
     OR NOT (NEW.`branch_id` <=> OLD.`branch_id`)
     OR NOT (NEW.`source` <=> OLD.`source`)
     OR NOT (NEW.`source_ref` <=> OLD.`source_ref`)
     OR NOT (NEW.`started_at` <=> OLD.`started_at`)
     OR NOT (NEW.`valid_until` <=> OLD.`valid_until`)
     OR NOT (NEW.`reason` <=> OLD.`reason`)
     OR NOT (NEW.`created_by_id` <=> OLD.`created_by_id`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'patient_care_relationships: paciente, odontólogo, clínica, sede, origen y vigencia son inmutables';
  END IF;
  IF OLD.`status` = 'ENDED' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'patient_care_relationships: una relación terminada no se modifica ni se reabre';
  END IF;
  IF NEW.`status` <> 'ENDED' OR NEW.`active_key` IS NOT NULL OR NEW.`ended_at` IS NULL OR NEW.`end_kind` IS NULL
     OR NEW.`end_reason` IS NULL OR CHAR_LENGTH(TRIM(NEW.`end_reason`)) < 3 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'patient_care_relationships: la única modificación permitida es terminarla, con motivo';
  END IF;
END;

CREATE TRIGGER `care_relationships_block_delete`
  BEFORE DELETE ON `patient_care_relationships` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'patient_care_relationships: las relaciones asistenciales no se eliminan';
END;

-- Autorización de lectura (clinical:read_all): solo se inserta; dura como máximo 30 minutos y exige una
-- justificación de al menos 10 caracteres. El tope de 30 minutos lo impone la base de datos.
CREATE TRIGGER `clinical_access_grants_validate`
  BEFORE INSERT ON `clinical_access_grants` FOR EACH ROW
BEGIN
  IF NEW.`expires_at` <= NEW.`granted_at` OR NEW.`expires_at` > (NEW.`granted_at` + INTERVAL 30 MINUTE) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_access_grants: la autorización dura como máximo 30 minutos';
  END IF;
  IF CHAR_LENGTH(TRIM(NEW.`reason`)) < 10 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_access_grants: la justificación exige al menos 10 caracteres';
  END IF;
END;

CREATE TRIGGER `clinical_access_grants_block_update`
  BEFORE UPDATE ON `clinical_access_grants` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_access_grants: las autorizaciones son inmutables';
END;

CREATE TRIGGER `clinical_access_grants_block_delete`
  BEFORE DELETE ON `clinical_access_grants` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_access_grants: las autorizaciones no se eliminan';
END;

-- clinical:read_all solo puede estar asociado al rol CLINICAL_DIRECTOR (ningún otro rol, ni por error de catálogo).
CREATE TRIGGER `role_permissions_read_all_only_director_ins`
  BEFORE INSERT ON `role_permissions` FOR EACH ROW
BEGIN
  IF (SELECT `code` FROM `permissions` WHERE `id` = NEW.`permission_id`) = 'clinical:read_all'
     AND (SELECT `code` FROM `roles` WHERE `id` = NEW.`role_id`) <> 'CLINICAL_DIRECTOR' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'role_permissions: clinical:read_all solo puede asignarse al rol CLINICAL_DIRECTOR';
  END IF;
END;

CREATE TRIGGER `role_permissions_read_all_only_director_upd`
  BEFORE UPDATE ON `role_permissions` FOR EACH ROW
BEGIN
  IF (SELECT `code` FROM `permissions` WHERE `id` = NEW.`permission_id`) = 'clinical:read_all'
     AND (SELECT `code` FROM `roles` WHERE `id` = NEW.`role_id`) <> 'CLINICAL_DIRECTOR' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'role_permissions: clinical:read_all solo puede asignarse al rol CLINICAL_DIRECTOR';
  END IF;
END;
