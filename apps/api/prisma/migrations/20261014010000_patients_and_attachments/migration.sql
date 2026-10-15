-- AlterTable
ALTER TABLE `audit_logs` ADD COLUMN `patient_id` CHAR(36) NULL;

-- CreateTable
CREATE TABLE `patients` (
    `id` CHAR(36) NOT NULL,
    `clinic_id` CHAR(36) NOT NULL,
    `first_name` VARCHAR(100) NOT NULL,
    `last_name` VARCHAR(100) NOT NULL,
    `second_last_name` VARCHAR(100) NULL,
    `birth_date` DATE NULL,
    `sex` ENUM('FEMALE', 'MALE', 'OTHER') NULL,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `status_reason` VARCHAR(300) NULL,
    `created_branch_id` CHAR(36) NULL,
    `created_by_id` CHAR(36) NOT NULL,
    `updated_by_id` CHAR(36) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `patients_clinic_id_last_name_first_name_idx`(`clinic_id`, `last_name`, `first_name`),
    INDEX `patients_clinic_id_birth_date_idx`(`clinic_id`, `birth_date`),
    INDEX `patients_clinic_id_status_idx`(`clinic_id`, `status`),
    UNIQUE INDEX `patients_id_clinic_id_key`(`id`, `clinic_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `patient_identifiers` (
    `id` CHAR(36) NOT NULL,
    `clinic_id` CHAR(36) NOT NULL,
    `patient_id` CHAR(36) NOT NULL,
    `type` ENUM('DNI', 'CE', 'PASSPORT') NOT NULL,
    `number` VARCHAR(20) NOT NULL,
    `status` ENUM('ACTIVE', 'SUPERSEDED') NOT NULL DEFAULT 'ACTIVE',
    `active_key` VARCHAR(80) NULL,
    `patient_type_key` VARCHAR(80) NULL,
    `change_reason` VARCHAR(300) NULL,
    `superseded_at` DATETIME(3) NULL,
    `created_by_id` CHAR(36) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `patient_identifiers_active_key_key`(`active_key`),
    UNIQUE INDEX `patient_identifiers_patient_type_key_key`(`patient_type_key`),
    INDEX `patient_identifiers_patient_id_idx`(`patient_id`),
    INDEX `patient_identifiers_clinic_id_number_idx`(`clinic_id`, `number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `patient_contacts` (
    `id` CHAR(36) NOT NULL,
    `clinic_id` CHAR(36) NOT NULL,
    `patient_id` CHAR(36) NOT NULL,
    `type` ENUM('MOBILE', 'PHONE', 'EMAIL', 'ADDRESS') NOT NULL,
    `value` VARCHAR(300) NOT NULL,
    `value_key` VARCHAR(254) NULL,
    `label` VARCHAR(60) NULL,
    `is_primary` BOOLEAN NOT NULL DEFAULT false,
    `status` ENUM('ACTIVE', 'SUPERSEDED') NOT NULL DEFAULT 'ACTIVE',
    `primary_key` VARCHAR(80) NULL,
    `active_key` VARCHAR(300) NULL,
    `change_reason` VARCHAR(300) NULL,
    `superseded_at` DATETIME(3) NULL,
    `created_by_id` CHAR(36) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `patient_contacts_primary_key_key`(`primary_key`),
    UNIQUE INDEX `patient_contacts_active_key_key`(`active_key`),
    INDEX `patient_contacts_patient_id_status_idx`(`patient_id`, `status`),
    INDEX `patient_contacts_clinic_id_type_value_key_idx`(`clinic_id`, `type`, `value_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `guardians` (
    `id` CHAR(36) NOT NULL,
    `clinic_id` CHAR(36) NOT NULL,
    `first_name` VARCHAR(100) NOT NULL,
    `last_name` VARCHAR(100) NOT NULL,
    `second_last_name` VARCHAR(100) NULL,
    `identifier_type` ENUM('DNI', 'CE', 'PASSPORT') NULL,
    `identifier_number` VARCHAR(20) NULL,
    `mobile` VARCHAR(20) NULL,
    `email` VARCHAR(254) NULL,
    `created_by_id` CHAR(36) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `guardians_clinic_id_last_name_idx`(`clinic_id`, `last_name`),
    INDEX `guardians_clinic_id_identifier_number_idx`(`clinic_id`, `identifier_number`),
    UNIQUE INDEX `guardians_id_clinic_id_key`(`id`, `clinic_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `patient_guardians` (
    `id` CHAR(36) NOT NULL,
    `clinic_id` CHAR(36) NOT NULL,
    `patient_id` CHAR(36) NOT NULL,
    `guardian_id` CHAR(36) NOT NULL,
    `relationship` ENUM('MOTHER', 'FATHER', 'LEGAL_GUARDIAN', 'GRANDPARENT', 'SIBLING', 'OTHER') NOT NULL,
    `is_primary` BOOLEAN NOT NULL DEFAULT false,
    `is_legal_representative` BOOLEAN NOT NULL DEFAULT false,
    `status` ENUM('ACTIVE', 'ENDED') NOT NULL DEFAULT 'ACTIVE',
    `active_key` VARCHAR(80) NULL,
    `ended_at` DATETIME(3) NULL,
    `end_reason` VARCHAR(300) NULL,
    `created_by_id` CHAR(36) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `patient_guardians_active_key_key`(`active_key`),
    INDEX `patient_guardians_patient_id_status_idx`(`patient_id`, `status`),
    INDEX `patient_guardians_guardian_id_idx`(`guardian_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `patient_consents` (
    `id` CHAR(36) NOT NULL,
    `clinic_id` CHAR(36) NOT NULL,
    `patient_id` CHAR(36) NOT NULL,
    `type` ENUM('CLINICAL', 'LOYALTY', 'MARKETING') NOT NULL,
    `status` ENUM('GRANTED', 'REVOKED') NOT NULL DEFAULT 'GRANTED',
    `document_title` VARCHAR(200) NOT NULL,
    `document_version` VARCHAR(60) NOT NULL,
    `granted_at` DATETIME(3) NOT NULL,
    `granted_by` ENUM('PATIENT', 'GUARDIAN') NOT NULL,
    `guardian_id` CHAR(36) NULL,
    `notes` VARCHAR(500) NULL,
    `active_key` VARCHAR(80) NULL,
    `revoked_at` DATETIME(3) NULL,
    `revoked_by_id` CHAR(36) NULL,
    `revocation_reason` VARCHAR(300) NULL,
    `created_by_id` CHAR(36) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `patient_consents_active_key_key`(`active_key`),
    INDEX `patient_consents_patient_id_type_idx`(`patient_id`, `type`),
    INDEX `patient_consents_clinic_id_type_status_idx`(`clinic_id`, `type`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `attachments` (
    `id` CHAR(36) NOT NULL,
    `clinic_id` CHAR(36) NOT NULL,
    `patient_id` CHAR(36) NOT NULL,
    `consent_id` CHAR(36) NULL,
    `category` ENUM('CONSENT', 'IDENTITY_DOCUMENT', 'OTHER_ADMINISTRATIVE') NOT NULL,
    `original_name` VARCHAR(160) NOT NULL,
    `mime_type` VARCHAR(100) NOT NULL,
    `size_bytes` INTEGER NOT NULL,
    `sha256` CHAR(64) NOT NULL,
    `storage_key` VARCHAR(120) NOT NULL,
    `description` VARCHAR(300) NULL,
    `status` ENUM('ACTIVE', 'REMOVED') NOT NULL DEFAULT 'ACTIVE',
    `removed_at` DATETIME(3) NULL,
    `removed_by_id` CHAR(36) NULL,
    `removal_reason` VARCHAR(300) NULL,
    `uploaded_by_id` CHAR(36) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `attachments_storage_key_key`(`storage_key`),
    INDEX `attachments_patient_id_status_idx`(`patient_id`, `status`),
    INDEX `attachments_consent_id_idx`(`consent_id`),
    INDEX `attachments_clinic_id_sha256_idx`(`clinic_id`, `sha256`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `audit_logs_patient_id_created_at_idx` ON `audit_logs`(`patient_id`, `created_at`);

-- AddForeignKey
ALTER TABLE `patients` ADD CONSTRAINT `patients_clinic_id_fkey` FOREIGN KEY (`clinic_id`) REFERENCES `clinics`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `patient_identifiers` ADD CONSTRAINT `patient_identifiers_patient_id_clinic_id_fkey` FOREIGN KEY (`patient_id`, `clinic_id`) REFERENCES `patients`(`id`, `clinic_id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `patient_contacts` ADD CONSTRAINT `patient_contacts_patient_id_clinic_id_fkey` FOREIGN KEY (`patient_id`, `clinic_id`) REFERENCES `patients`(`id`, `clinic_id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `patient_guardians` ADD CONSTRAINT `patient_guardians_patient_id_clinic_id_fkey` FOREIGN KEY (`patient_id`, `clinic_id`) REFERENCES `patients`(`id`, `clinic_id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `patient_guardians` ADD CONSTRAINT `patient_guardians_guardian_id_clinic_id_fkey` FOREIGN KEY (`guardian_id`, `clinic_id`) REFERENCES `guardians`(`id`, `clinic_id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `patient_consents` ADD CONSTRAINT `patient_consents_patient_id_clinic_id_fkey` FOREIGN KEY (`patient_id`, `clinic_id`) REFERENCES `patients`(`id`, `clinic_id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attachments` ADD CONSTRAINT `attachments_patient_id_clinic_id_fkey` FOREIGN KEY (`patient_id`, `clinic_id`) REFERENCES `patients`(`id`, `clinic_id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attachments` ADD CONSTRAINT `attachments_consent_id_fkey` FOREIGN KEY (`consent_id`) REFERENCES `patient_consents`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Garantías que Prisma no expresa (agregadas manualmente)
-- ---------------------------------------------------------------------------

-- La identidad del paciente es inmutable: ni su id ni su clínica pueden cambiar.
CREATE TRIGGER `patients_immutable_keys`
  BEFORE UPDATE ON `patients` FOR EACH ROW
BEGIN
  IF NOT (NEW.`id` <=> OLD.`id`) OR NOT (NEW.`clinic_id` <=> OLD.`clinic_id`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'patients.id y patients.clinic_id son inmutables';
  END IF;
END;

-- Un consentimiento es un registro legal: solo cambian los campos de revocación y las notas.
-- Un consentimiento revocado no vuelve a estar vigente (se registra uno nuevo).
CREATE TRIGGER `patient_consents_immutable_record`
  BEFORE UPDATE ON `patient_consents` FOR EACH ROW
BEGIN
  IF NOT (NEW.`id` <=> OLD.`id`)
     OR NOT (NEW.`clinic_id` <=> OLD.`clinic_id`)
     OR NOT (NEW.`patient_id` <=> OLD.`patient_id`)
     OR NOT (NEW.`type` <=> OLD.`type`)
     OR NOT (NEW.`document_title` <=> OLD.`document_title`)
     OR NOT (NEW.`document_version` <=> OLD.`document_version`)
     OR NOT (NEW.`granted_at` <=> OLD.`granted_at`)
     OR NOT (NEW.`granted_by` <=> OLD.`granted_by`)
     OR NOT (NEW.`guardian_id` <=> OLD.`guardian_id`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'patient_consents: el contenido del consentimiento es inmutable';
  END IF;
  IF OLD.`status` = 'REVOKED' AND NEW.`status` <> 'REVOKED' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'patient_consents: un consentimiento revocado no puede reactivarse';
  END IF;
END;

-- Un adjunto no puede alterarse: ni su contenido (hash, ubicación, tamaño, tipo) ni su dueño.
-- Solo cambian los campos de baja lógica y la descripción.
CREATE TRIGGER `attachments_immutable_content`
  BEFORE UPDATE ON `attachments` FOR EACH ROW
BEGIN
  IF NOT (NEW.`id` <=> OLD.`id`)
     OR NOT (NEW.`clinic_id` <=> OLD.`clinic_id`)
     OR NOT (NEW.`patient_id` <=> OLD.`patient_id`)
     OR NOT (NEW.`consent_id` <=> OLD.`consent_id`)
     OR NOT (NEW.`category` <=> OLD.`category`)
     OR NOT (NEW.`original_name` <=> OLD.`original_name`)
     OR NOT (NEW.`mime_type` <=> OLD.`mime_type`)
     OR NOT (NEW.`size_bytes` <=> OLD.`size_bytes`)
     OR NOT (NEW.`sha256` <=> OLD.`sha256`)
     OR NOT (NEW.`storage_key` <=> OLD.`storage_key`)
     OR NOT (NEW.`uploaded_by_id` <=> OLD.`uploaded_by_id`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'attachments: el contenido y los metadatos del archivo son inmutables';
  END IF;
  IF OLD.`status` = 'REMOVED' AND NEW.`status` <> 'REMOVED' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'attachments: una baja lógica no se revierte';
  END IF;
END;

-- Sin eliminación física de pacientes, consentimientos, adjuntos ni de su historial.
CREATE TRIGGER `patients_block_delete`
  BEFORE DELETE ON `patients` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'patients: no se permite eliminación física';

CREATE TRIGGER `patient_consents_block_delete`
  BEFORE DELETE ON `patient_consents` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'patient_consents: no se permite eliminación física';

CREATE TRIGGER `attachments_block_delete`
  BEFORE DELETE ON `attachments` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'attachments: no se permite eliminación física';

CREATE TRIGGER `patient_identifiers_block_delete`
  BEFORE DELETE ON `patient_identifiers` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'patient_identifiers: no se permite eliminación física';

CREATE TRIGGER `patient_contacts_block_delete`
  BEFORE DELETE ON `patient_contacts` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'patient_contacts: no se permite eliminación física';

CREATE TRIGGER `patient_guardians_block_delete`
  BEFORE DELETE ON `patient_guardians` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'patient_guardians: no se permite eliminación física';

CREATE TRIGGER `guardians_block_delete`
  BEFORE DELETE ON `guardians` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'guardians: no se permite eliminación física';
