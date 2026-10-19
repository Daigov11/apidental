-- AlterTable: categorías clínicas de adjuntos (radiografías, fotos, estudios)
ALTER TABLE `attachments` MODIFY `category` ENUM('CONSENT', 'IDENTITY_DOCUMENT', 'OTHER_ADMINISTRATIVE', 'XRAY', 'CLINICAL_PHOTO', 'STUDY', 'OTHER_CLINICAL') NOT NULL;

-- CreateTable
CREATE TABLE `prescriptions` (
    `id` CHAR(36) NOT NULL,
    `clinic_id` CHAR(36) NOT NULL,
    `patient_id` CHAR(36) NOT NULL,
    `visit_id` CHAR(36) NULL,
    `number` INTEGER NOT NULL,
    `prescriber_id` CHAR(36) NOT NULL,
    `diagnosis` VARCHAR(300) NULL,
    `notes` VARCHAR(1000) NULL,
    `status` ENUM('ACTIVE', 'DELETED') NOT NULL DEFAULT 'ACTIVE',
    `deleted_at` DATETIME(3) NULL,
    `deleted_by_id` CHAR(36) NULL,
    `delete_reason` VARCHAR(300) NULL,
    `last_emailed_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `prescriptions_patient_id_status_created_at_idx`(`patient_id`, `status`, `created_at`),
    INDEX `prescriptions_clinic_id_prescriber_id_created_at_idx`(`clinic_id`, `prescriber_id`, `created_at`),
    UNIQUE INDEX `prescriptions_clinic_id_number_key`(`clinic_id`, `number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `prescription_items` (
    `id` CHAR(36) NOT NULL,
    `prescription_id` CHAR(36) NOT NULL,
    `position` INTEGER NOT NULL,
    `medication` VARCHAR(200) NOT NULL,
    `dose` VARCHAR(120) NULL,
    `frequency` VARCHAR(120) NULL,
    `duration` VARCHAR(120) NULL,
    `instructions` VARCHAR(300) NULL,

    INDEX `prescription_items_prescription_id_position_idx`(`prescription_id`, `position`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `prescriptions` ADD CONSTRAINT `prescriptions_patient_id_clinic_id_fkey` FOREIGN KEY (`patient_id`, `clinic_id`) REFERENCES `patients`(`id`, `clinic_id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `prescription_items` ADD CONSTRAINT `prescription_items_prescription_id_fkey` FOREIGN KEY (`prescription_id`) REFERENCES `prescriptions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
