-- AlterTable
ALTER TABLE `users` ADD COLUMN `disabled_at` DATETIME(3) NULL,
    ADD COLUMN `disabled_by_id` CHAR(36) NULL,
    ADD COLUMN `disabled_by_platform` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `disabled_reason` VARCHAR(300) NULL;

-- AlterTable
ALTER TABLE `auth_sessions` MODIFY `revoked_reason` ENUM('LOGOUT', 'LOGOUT_ALL', 'REUSE_DETECTED', 'EXPIRED', 'USER_DISABLED', 'PASSWORD_RESET') NULL;

-- CreateTable
CREATE TABLE `password_recoveries` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `token_hash` CHAR(64) NOT NULL,
    `status` ENUM('PENDING', 'USED', 'REVOKED', 'EXPIRED') NOT NULL DEFAULT 'PENDING',
    `pending_key` CHAR(36) NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `request_ip` VARCHAR(64) NULL,
    `request_user_agent` VARCHAR(255) NULL,
    `delivery_status` ENUM('PENDING', 'SENT', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `delivery_attempts` INTEGER NOT NULL DEFAULT 0,
    `last_delivery_at` DATETIME(3) NULL,
    `last_delivery_error` VARCHAR(120) NULL,
    `used_at` DATETIME(3) NULL,
    `used_ip` VARCHAR(64) NULL,
    `revoked_at` DATETIME(3) NULL,
    `revoked_reason` VARCHAR(120) NULL,
    `expired_at` DATETIME(3) NULL,

    UNIQUE INDEX `password_recoveries_token_hash_key`(`token_hash`),
    UNIQUE INDEX `password_recoveries_pending_key_key`(`pending_key`),
    INDEX `password_recoveries_user_id_created_at_idx`(`user_id`, `created_at`),
    INDEX `password_recoveries_status_expires_at_idx`(`status`, `expires_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `password_recoveries` ADD CONSTRAINT `password_recoveries_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Garantías que Prisma no expresa (agregadas manualmente)
-- ---------------------------------------------------------------------------

-- Recuperación de contraseña: quién y qué token no cambian; una recuperación cerrada no se reabre.
CREATE TRIGGER `password_recoveries_immutable_core`
  BEFORE UPDATE ON `password_recoveries` FOR EACH ROW
BEGIN
  IF NOT (NEW.`user_id` <=> OLD.`user_id`)
     OR NOT (NEW.`token_hash` <=> OLD.`token_hash`)
     OR NOT (NEW.`created_at` <=> OLD.`created_at`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'password_recoveries: usuario, token y fecha de creación son inmutables';
  END IF;
  IF OLD.`status` <> 'PENDING' AND NEW.`status` <> OLD.`status` THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'password_recoveries: una recuperación cerrada no cambia de estado';
  END IF;
END;

-- Depuración (mantenimiento): solo se pueden eliminar registros CERRADOS y con al menos 30 días.
-- El mínimo de retención lo impone la base de datos, aunque la configuración pidiera menos.
CREATE TRIGGER `password_recoveries_purge_only_old_closed`
  BEFORE DELETE ON `password_recoveries` FOR EACH ROW
BEGIN
  IF OLD.`status` = 'PENDING' OR OLD.`created_at` > (UTC_TIMESTAMP(3) - INTERVAL 30 DAY) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'password_recoveries: solo se purgan recuperaciones cerradas con más de 30 días';
  END IF;
END;

-- Invitaciones: antes no se podían eliminar nunca; ahora el mantenimiento puede depurar las CERRADAS
-- con más de 30 días (la auditoría conserva su rastro). Una pendiente o reciente sigue protegida.
DROP TRIGGER `invitations_block_delete`;

CREATE TRIGGER `invitations_purge_only_old_closed`
  BEFORE DELETE ON `invitations` FOR EACH ROW
BEGIN
  IF OLD.`status` = 'PENDING' OR OLD.`created_at` > (UTC_TIMESTAMP(3) - INTERVAL 30 DAY) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'invitations: solo se purgan invitaciones cerradas con más de 30 días';
  END IF;
END;
