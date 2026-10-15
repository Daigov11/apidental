-- CreateTable
CREATE TABLE `auth_sessions` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `last_used_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `absolute_expires_at` DATETIME(3) NOT NULL,
    `revoked_at` DATETIME(3) NULL,
    `revoked_reason` ENUM('LOGOUT', 'LOGOUT_ALL', 'REUSE_DETECTED', 'EXPIRED', 'USER_DISABLED') NULL,
    `ip` VARCHAR(64) NULL,
    `user_agent` VARCHAR(255) NULL,
    `context_set` BOOLEAN NOT NULL DEFAULT false,
    `context_clinic_id` CHAR(36) NULL,
    `context_branch_id` CHAR(36) NULL,

    INDEX `auth_sessions_user_id_revoked_at_idx`(`user_id`, `revoked_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `refresh_tokens` (
    `id` CHAR(36) NOT NULL,
    `session_id` CHAR(36) NOT NULL,
    `token_hash` CHAR(64) NOT NULL,
    `status` ENUM('ACTIVE', 'ROTATED', 'REVOKED') NOT NULL DEFAULT 'ACTIVE',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expires_at` DATETIME(3) NOT NULL,
    `rotated_at` DATETIME(3) NULL,
    `replaced_by_id` CHAR(36) NULL,

    UNIQUE INDEX `refresh_tokens_token_hash_key`(`token_hash`),
    INDEX `refresh_tokens_session_id_status_idx`(`session_id`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `reauth_proofs` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `session_id` CHAR(36) NOT NULL,
    `purpose` ENUM('CLOSE_CLINICAL_NOTE', 'CORRECT_CLINICAL_NOTE', 'MARK_CLINICAL_NOTE_ERROR', 'CLINICAL_READ_ALL', 'AUTHORIZE_DIRECTOR_PROVISIONING') NOT NULL,
    `target_id` VARCHAR(64) NULL,
    `token_hash` CHAR(64) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expires_at` DATETIME(3) NOT NULL,
    `used_at` DATETIME(3) NULL,
    `ip` VARCHAR(64) NULL,

    UNIQUE INDEX `reauth_proofs_token_hash_key`(`token_hash`),
    INDEX `reauth_proofs_user_id_created_at_idx`(`user_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `invitations` (
    `id` CHAR(36) NOT NULL,
    `email` VARCHAR(254) NOT NULL,
    `role_id` CHAR(36) NOT NULL,
    `clinic_id` CHAR(36) NULL,
    `branch_id` CHAR(36) NULL,
    `token_hash` CHAR(64) NOT NULL,
    `status` ENUM('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED') NOT NULL DEFAULT 'PENDING',
    `pending_key` VARCHAR(400) NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `created_by_id` CHAR(36) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `delivery_status` ENUM('PENDING', 'SENT', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `delivery_attempts` INTEGER NOT NULL DEFAULT 0,
    `last_delivery_at` DATETIME(3) NULL,
    `last_delivery_error` VARCHAR(120) NULL,
    `token_rotated_at` DATETIME(3) NULL,
    `accepted_at` DATETIME(3) NULL,
    `accepted_user_id` CHAR(36) NULL,
    `revoked_at` DATETIME(3) NULL,
    `revoked_by_id` CHAR(36) NULL,
    `revoke_reason` VARCHAR(300) NULL,
    `expired_at` DATETIME(3) NULL,
    `provisioning_record_id` CHAR(36) NULL,

    UNIQUE INDEX `invitations_token_hash_key`(`token_hash`),
    UNIQUE INDEX `invitations_pending_key_key`(`pending_key`),
    INDEX `invitations_clinic_id_status_idx`(`clinic_id`, `status`),
    INDEX `invitations_email_idx`(`email`),
    INDEX `invitations_status_expires_at_idx`(`status`, `expires_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `provisioning_records` (
    `id` CHAR(36) NOT NULL,
    `clinic_id` CHAR(36) NOT NULL,
    `kind` ENUM('FIRST_CLINICAL_DIRECTOR') NOT NULL,
    `status` ENUM('ACTIVE', 'CONSUMED', 'REVOKED', 'EXPIRED') NOT NULL DEFAULT 'ACTIVE',
    `active_key` VARCHAR(80) NULL,
    `designee_name` VARCHAR(200) NOT NULL,
    `designee_email` VARCHAR(254) NOT NULL,
    `authorized_by_name` VARCHAR(200) NOT NULL,
    `authorized_by_position` VARCHAR(120) NOT NULL,
    `authorized_by_document_type` VARCHAR(10) NOT NULL,
    `authorized_by_document_number` VARCHAR(20) NOT NULL,
    `authorization_reference` VARCHAR(200) NOT NULL,
    `authorization_date` DATE NOT NULL,
    `notes` VARCHAR(500) NULL,
    `recorded_by_id` CHAR(36) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expires_at` DATETIME(3) NOT NULL,
    `consumed_at` DATETIME(3) NULL,
    `consumed_invitation_id` CHAR(36) NULL,
    `revoked_at` DATETIME(3) NULL,
    `revoked_by_id` CHAR(36) NULL,
    `revoke_reason` VARCHAR(300) NULL,

    UNIQUE INDEX `provisioning_records_active_key_key`(`active_key`),
    INDEX `provisioning_records_clinic_id_status_idx`(`clinic_id`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `auth_sessions` ADD CONSTRAINT `auth_sessions_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `refresh_tokens` ADD CONSTRAINT `refresh_tokens_session_id_fkey` FOREIGN KEY (`session_id`) REFERENCES `auth_sessions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `reauth_proofs` ADD CONSTRAINT `reauth_proofs_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `reauth_proofs` ADD CONSTRAINT `reauth_proofs_session_id_fkey` FOREIGN KEY (`session_id`) REFERENCES `auth_sessions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `invitations` ADD CONSTRAINT `invitations_role_id_fkey` FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `invitations` ADD CONSTRAINT `invitations_clinic_id_fkey` FOREIGN KEY (`clinic_id`) REFERENCES `clinics`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `invitations` ADD CONSTRAINT `invitations_branch_id_clinic_id_fkey` FOREIGN KEY (`branch_id`, `clinic_id`) REFERENCES `branches`(`id`, `clinic_id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `invitations` ADD CONSTRAINT `invitations_provisioning_record_id_fkey` FOREIGN KEY (`provisioning_record_id`) REFERENCES `provisioning_records`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `provisioning_records` ADD CONSTRAINT `provisioning_records_clinic_id_fkey` FOREIGN KEY (`clinic_id`) REFERENCES `clinics`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Garantías que Prisma no expresa (agregadas manualmente)
-- ---------------------------------------------------------------------------

-- Una invitación con sede exige clínica (mismo criterio que user_assignments).
ALTER TABLE `invitations`
  ADD CONSTRAINT `invitations_branch_requires_clinic_chk`
  CHECK (`branch_id` IS NULL OR `clinic_id` IS NOT NULL);

-- Lo que se invitó no puede alterarse después (ni siquiera por SQL directo): evita "ascender" una
-- invitación pendiente cambiando su rol o su alcance. Solo avanzan los campos de estado y entrega.
CREATE TRIGGER `invitations_immutable_target`
  BEFORE UPDATE ON `invitations` FOR EACH ROW
BEGIN
  IF NOT (NEW.`email` <=> OLD.`email`)
     OR NOT (NEW.`role_id` <=> OLD.`role_id`)
     OR NOT (NEW.`clinic_id` <=> OLD.`clinic_id`)
     OR NOT (NEW.`branch_id` <=> OLD.`branch_id`)
     OR NOT (NEW.`created_by_id` <=> OLD.`created_by_id`)
     OR NOT (NEW.`provisioning_record_id` <=> OLD.`provisioning_record_id`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'invitations: destinatario, rol y alcance son inmutables';
  END IF;
  IF OLD.`status` <> 'PENDING' AND NEW.`status` <> OLD.`status` THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'invitations: una invitación cerrada no cambia de estado';
  END IF;
END;

CREATE TRIGGER `invitations_block_delete`
  BEFORE DELETE ON `invitations` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'invitations: no se permite eliminación física';

-- El registro de aprovisionamiento es evidencia formal: solo avanzan su estado y su consumo/revocación.
CREATE TRIGGER `provisioning_records_immutable_content`
  BEFORE UPDATE ON `provisioning_records` FOR EACH ROW
BEGIN
  IF NOT (NEW.`clinic_id` <=> OLD.`clinic_id`)
     OR NOT (NEW.`kind` <=> OLD.`kind`)
     OR NOT (NEW.`designee_name` <=> OLD.`designee_name`)
     OR NOT (NEW.`designee_email` <=> OLD.`designee_email`)
     OR NOT (NEW.`authorized_by_name` <=> OLD.`authorized_by_name`)
     OR NOT (NEW.`authorized_by_position` <=> OLD.`authorized_by_position`)
     OR NOT (NEW.`authorized_by_document_type` <=> OLD.`authorized_by_document_type`)
     OR NOT (NEW.`authorized_by_document_number` <=> OLD.`authorized_by_document_number`)
     OR NOT (NEW.`authorization_reference` <=> OLD.`authorization_reference`)
     OR NOT (NEW.`authorization_date` <=> OLD.`authorization_date`)
     OR NOT (NEW.`recorded_by_id` <=> OLD.`recorded_by_id`)
     OR NOT (NEW.`created_at` <=> OLD.`created_at`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'provisioning_records: el contenido del registro formal es inmutable';
  END IF;
  IF OLD.`status` <> 'ACTIVE' AND NEW.`status` <> OLD.`status` THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'provisioning_records: un registro cerrado no cambia de estado';
  END IF;
END;

CREATE TRIGGER `provisioning_records_block_delete`
  BEFORE DELETE ON `provisioning_records` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'provisioning_records: no se permite eliminación física';

-- Una prueba de reautenticación solo puede marcarse como usada, una vez.
CREATE TRIGGER `reauth_proofs_single_use`
  BEFORE UPDATE ON `reauth_proofs` FOR EACH ROW
BEGIN
  IF NOT (NEW.`user_id` <=> OLD.`user_id`)
     OR NOT (NEW.`session_id` <=> OLD.`session_id`)
     OR NOT (NEW.`purpose` <=> OLD.`purpose`)
     OR NOT (NEW.`target_id` <=> OLD.`target_id`)
     OR NOT (NEW.`token_hash` <=> OLD.`token_hash`)
     OR NOT (NEW.`expires_at` <=> OLD.`expires_at`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'reauth_proofs: la prueba es inmutable salvo su marca de uso';
  END IF;
  IF OLD.`used_at` IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'reauth_proofs: la prueba ya fue usada';
  END IF;
END;

-- El hash de un refresh token no cambia nunca; los tokens rotados se conservan para detectar su reutilización.
CREATE TRIGGER `refresh_tokens_immutable_hash`
  BEFORE UPDATE ON `refresh_tokens` FOR EACH ROW
BEGIN
  IF NOT (NEW.`token_hash` <=> OLD.`token_hash`) OR NOT (NEW.`session_id` <=> OLD.`session_id`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'refresh_tokens: el hash y la sesión son inmutables';
  END IF;
END;
