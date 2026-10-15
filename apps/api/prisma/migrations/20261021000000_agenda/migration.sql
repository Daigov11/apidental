-- CreateTable
CREATE TABLE `rooms` (
    `id` CHAR(36) NOT NULL,
    `clinic_id` CHAR(36) NOT NULL,
    `branch_id` CHAR(36) NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `rooms_branch_id_name_key`(`branch_id`, `name`),
    UNIQUE INDEX `rooms_id_branch_id_key`(`id`, `branch_id`),
    UNIQUE INDEX `rooms_id_clinic_id_key`(`id`, `clinic_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `specialties` (
    `id` CHAR(36) NOT NULL,
    `clinic_id` CHAR(36) NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `specialties_clinic_id_name_key`(`clinic_id`, `name`),
    UNIQUE INDEX `specialties_id_clinic_id_key`(`id`, `clinic_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `agenda_services` (
    `id` CHAR(36) NOT NULL,
    `clinic_id` CHAR(36) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `specialty_id` CHAR(36) NULL,
    `duration_minutes` INTEGER NOT NULL,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `agenda_services_clinic_id_name_key`(`clinic_id`, `name`),
    UNIQUE INDEX `agenda_services_id_clinic_id_key`(`id`, `clinic_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `dentist_specialties` (
    `clinic_id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `specialty_id` CHAR(36) NOT NULL,

    INDEX `dentist_specialties_clinic_id_idx`(`clinic_id`),
    PRIMARY KEY (`user_id`, `specialty_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `schedule_rules` (
    `id` CHAR(36) NOT NULL,
    `clinic_id` CHAR(36) NOT NULL,
    `branch_id` CHAR(36) NOT NULL,
    `dentist_user_id` CHAR(36) NOT NULL,
    `room_id` CHAR(36) NULL,
    `weekday` INTEGER NOT NULL,
    `start_minute` INTEGER NOT NULL,
    `end_minute` INTEGER NOT NULL,
    `valid_from` DATE NOT NULL,
    `valid_until` DATE NULL,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `created_by_id` CHAR(36) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `schedule_rules_clinic_id_branch_id_dentist_user_id_status_idx`(`clinic_id`, `branch_id`, `dentist_user_id`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `schedule_blocks` (
    `id` CHAR(36) NOT NULL,
    `clinic_id` CHAR(36) NOT NULL,
    `branch_id` CHAR(36) NOT NULL,
    `dentist_user_id` CHAR(36) NULL,
    `room_id` CHAR(36) NULL,
    `starts_at` DATETIME(3) NOT NULL,
    `ends_at` DATETIME(3) NOT NULL,
    `reason` VARCHAR(300) NOT NULL,
    `status` ENUM('ACTIVE', 'RELEASED') NOT NULL DEFAULT 'ACTIVE',
    `created_by_id` CHAR(36) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `released_at` DATETIME(3) NULL,
    `released_by_id` CHAR(36) NULL,
    `release_reason` VARCHAR(300) NULL,

    INDEX `schedule_blocks_clinic_id_branch_id_starts_at_idx`(`clinic_id`, `branch_id`, `starts_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `appointments` (
    `id` CHAR(36) NOT NULL,
    `clinic_id` CHAR(36) NOT NULL,
    `branch_id` CHAR(36) NOT NULL,
    `patient_id` CHAR(36) NOT NULL,
    `dentist_user_id` CHAR(36) NOT NULL,
    `room_id` CHAR(36) NOT NULL,
    `service_id` CHAR(36) NOT NULL,
    `starts_at` DATETIME(3) NOT NULL,
    `ends_at` DATETIME(3) NOT NULL,
    `status` ENUM('RESERVED', 'CONFIRMED', 'ATTENDED', 'CANCELLED', 'NO_SHOW') NOT NULL DEFAULT 'RESERVED',
    `notes` VARCHAR(300) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_by_id` CHAR(36) NOT NULL,
    `confirmed_by_id` CHAR(36) NULL,
    `confirmed_at` DATETIME(3) NULL,
    `cancel_reason` VARCHAR(300) NULL,
    `no_show_reason` VARCHAR(300) NULL,
    `rescheduled_count` INTEGER NOT NULL DEFAULT 0,
    `visit_id` CHAR(36) NULL,
    `attended_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `appointments_visit_id_key`(`visit_id`),
    INDEX `appointments_clinic_id_branch_id_starts_at_idx`(`clinic_id`, `branch_id`, `starts_at`),
    INDEX `appointments_dentist_user_id_starts_at_idx`(`dentist_user_id`, `starts_at`),
    INDEX `appointments_patient_id_starts_at_idx`(`patient_id`, `starts_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `appointment_slots` (
    `resource_kind` ENUM('DENTIST', 'ROOM') NOT NULL,
    `resource_id` CHAR(36) NOT NULL,
    `slot_start` DATETIME(0) NOT NULL,
    `owner_kind` ENUM('APPOINTMENT', 'BLOCK') NOT NULL,
    `owner_id` CHAR(36) NOT NULL,
    `clinic_id` CHAR(36) NOT NULL,

    INDEX `appointment_slots_owner_kind_owner_id_idx`(`owner_kind`, `owner_id`),
    INDEX `appointment_slots_clinic_id_slot_start_idx`(`clinic_id`, `slot_start`),
    PRIMARY KEY (`resource_kind`, `resource_id`, `slot_start`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `rooms` ADD CONSTRAINT `rooms_clinic_id_fkey` FOREIGN KEY (`clinic_id`) REFERENCES `clinics`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `rooms` ADD CONSTRAINT `rooms_branch_id_clinic_id_fkey` FOREIGN KEY (`branch_id`, `clinic_id`) REFERENCES `branches`(`id`, `clinic_id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `specialties` ADD CONSTRAINT `specialties_clinic_id_fkey` FOREIGN KEY (`clinic_id`) REFERENCES `clinics`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `agenda_services` ADD CONSTRAINT `agenda_services_clinic_id_fkey` FOREIGN KEY (`clinic_id`) REFERENCES `clinics`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `agenda_services` ADD CONSTRAINT `agenda_services_specialty_id_clinic_id_fkey` FOREIGN KEY (`specialty_id`, `clinic_id`) REFERENCES `specialties`(`id`, `clinic_id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `dentist_specialties` ADD CONSTRAINT `dentist_specialties_specialty_id_clinic_id_fkey` FOREIGN KEY (`specialty_id`, `clinic_id`) REFERENCES `specialties`(`id`, `clinic_id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `schedule_rules` ADD CONSTRAINT `schedule_rules_room_id_branch_id_fkey` FOREIGN KEY (`room_id`, `branch_id`) REFERENCES `rooms`(`id`, `branch_id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `appointments` ADD CONSTRAINT `appointments_patient_id_clinic_id_fkey` FOREIGN KEY (`patient_id`, `clinic_id`) REFERENCES `patients`(`id`, `clinic_id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `appointments` ADD CONSTRAINT `appointments_branch_id_clinic_id_fkey` FOREIGN KEY (`branch_id`, `clinic_id`) REFERENCES `branches`(`id`, `clinic_id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `appointments` ADD CONSTRAINT `appointments_room_id_branch_id_fkey` FOREIGN KEY (`room_id`, `branch_id`) REFERENCES `rooms`(`id`, `branch_id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `appointments` ADD CONSTRAINT `appointments_service_id_clinic_id_fkey` FOREIGN KEY (`service_id`, `clinic_id`) REFERENCES `agenda_services`(`id`, `clinic_id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `appointments` ADD CONSTRAINT `appointments_dentist_user_id_fkey` FOREIGN KEY (`dentist_user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `appointments` ADD CONSTRAINT `appointments_visit_id_fkey` FOREIGN KEY (`visit_id`) REFERENCES `clinical_visits`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- 4.0: garantías en la base de datos para la agenda
-- ===========================================================================

-- Citas y huecos alineados a 5 minutos; fin posterior al inicio y duración múltiplo de 5.
ALTER TABLE `appointments`
  ADD CONSTRAINT `appointments_time_check` CHECK (
    `ends_at` > `starts_at`
    AND MICROSECOND(`starts_at`) = 0 AND MICROSECOND(`ends_at`) = 0
    AND MOD(TIME_TO_SEC(TIME(`starts_at`)), 300) = 0
    AND MOD(TIMESTAMPDIFF(SECOND, `starts_at`, `ends_at`), 300) = 0
    AND TIMESTAMPDIFF(MINUTE, `starts_at`, `ends_at`) <= 480);

ALTER TABLE `schedule_blocks`
  ADD CONSTRAINT `schedule_blocks_time_check` CHECK (
    `ends_at` > `starts_at`
    AND MOD(TIME_TO_SEC(TIME(`starts_at`)), 300) = 0 AND MOD(TIMESTAMPDIFF(SECOND, `starts_at`, `ends_at`), 300) = 0
    AND (`dentist_user_id` IS NOT NULL OR `room_id` IS NOT NULL));

ALTER TABLE `appointment_slots`
  ADD CONSTRAINT `appointment_slots_aligned` CHECK (MOD(TIME_TO_SEC(TIME(`slot_start`)), 300) = 0);

ALTER TABLE `schedule_rules`
  ADD CONSTRAINT `schedule_rules_check` CHECK (
    `weekday` BETWEEN 1 AND 7 AND `start_minute` >= 0 AND `end_minute` <= 1440 AND `start_minute` < `end_minute`
    AND MOD(`start_minute`, 5) = 0 AND MOD(`end_minute`, 5) = 0);

ALTER TABLE `agenda_services`
  ADD CONSTRAINT `agenda_services_duration_check` CHECK (`duration_minutes` BETWEEN 5 AND 480 AND MOD(`duration_minutes`, 5) = 0);

-- Cita: núcleo inmutable y transiciones de estado válidas (RESERVED/CONFIRMED -> ATTENDED | CANCELLED | NO_SHOW).
CREATE TRIGGER `appointments_guard_update`
  BEFORE UPDATE ON `appointments` FOR EACH ROW
BEGIN
  IF NOT (NEW.`clinic_id` <=> OLD.`clinic_id`) OR NOT (NEW.`patient_id` <=> OLD.`patient_id`)
     OR NOT (NEW.`created_by_id` <=> OLD.`created_by_id`) OR NOT (NEW.`created_at` <=> OLD.`created_at`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'appointments: clínica, paciente y creador son inmutables';
  END IF;
  IF OLD.`status` IN ('ATTENDED', 'CANCELLED', 'NO_SHOW') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'appointments: una cita atendida, cancelada o ausente no se modifica';
  END IF;
  IF NEW.`version` <> OLD.`version` + 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'appointments: cada cambio incrementa la versión en uno';
  END IF;
  IF NEW.`status` = 'ATTENDED' AND (NEW.`visit_id` IS NULL OR NEW.`attended_at` IS NULL) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'appointments: una cita atendida queda vinculada a su visita';
  END IF;
  IF NEW.`status` <> 'ATTENDED' AND NEW.`visit_id` IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'appointments: solo una cita atendida tiene visita';
  END IF;
  IF NEW.`status` = 'CANCELLED' AND CHAR_LENGTH(TRIM(COALESCE(NEW.`cancel_reason`, ''))) < 3 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'appointments: cancelar exige un motivo de al menos 3 caracteres';
  END IF;
  IF NEW.`status` = 'NO_SHOW' THEN
    IF CHAR_LENGTH(TRIM(COALESCE(NEW.`no_show_reason`, ''))) < 3 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'appointments: marcar ausencia exige un motivo de al menos 3 caracteres';
    END IF;
    IF OLD.`starts_at` > UTC_TIMESTAMP(3) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'appointments: no se marca ausencia antes de la hora de la cita';
    END IF;
  END IF;
  IF NEW.`status` = 'CONFIRMED' AND NEW.`confirmed_by_id` IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'appointments: confirmar registra quién confirmó';
  END IF;
END;

CREATE TRIGGER `appointments_block_delete`
  BEFORE DELETE ON `appointments` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'appointments: las citas no se eliminan; se cancelan';
END;

-- Bloqueo: solo puede liberarse (una vez).
CREATE TRIGGER `schedule_blocks_guard_update`
  BEFORE UPDATE ON `schedule_blocks` FOR EACH ROW
BEGIN
  IF NOT (NEW.`clinic_id` <=> OLD.`clinic_id`) OR NOT (NEW.`branch_id` <=> OLD.`branch_id`) OR NOT (NEW.`dentist_user_id` <=> OLD.`dentist_user_id`)
     OR NOT (NEW.`room_id` <=> OLD.`room_id`) OR NOT (NEW.`starts_at` <=> OLD.`starts_at`) OR NOT (NEW.`ends_at` <=> OLD.`ends_at`)
     OR NOT (NEW.`reason` <=> OLD.`reason`) OR NOT (NEW.`created_by_id` <=> OLD.`created_by_id`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'schedule_blocks: el bloqueo no cambia; solo puede liberarse';
  END IF;
  IF OLD.`status` = 'RELEASED' OR NEW.`status` <> 'RELEASED' OR NEW.`released_at` IS NULL OR CHAR_LENGTH(TRIM(COALESCE(NEW.`release_reason`, ''))) < 3 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'schedule_blocks: liberar exige motivo y solo ocurre una vez';
  END IF;
END;

CREATE TRIGGER `schedule_blocks_block_delete`
  BEFORE DELETE ON `schedule_blocks` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'schedule_blocks: los bloqueos no se eliminan; se liberan';
END;
