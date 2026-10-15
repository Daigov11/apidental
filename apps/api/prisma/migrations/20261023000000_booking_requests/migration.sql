-- CreateTable
CREATE TABLE `booking_requests` (
    `id` CHAR(36) NOT NULL,
    `reference` VARCHAR(16) NOT NULL,
    `clinic_id` CHAR(36) NOT NULL,
    `branch_id` CHAR(36) NOT NULL,
    `service_id` CHAR(36) NOT NULL,
    `desired_starts_at` DATETIME(3) NOT NULL,
    `first_name` VARCHAR(100) NOT NULL,
    `last_name` VARCHAR(100) NOT NULL,
    `second_last_name` VARCHAR(100) NULL,
    `document_type` VARCHAR(12) NULL,
    `document_number` VARCHAR(40) NULL,
    `mobile` VARCHAR(20) NOT NULL,
    `email` VARCHAR(254) NULL,
    `notes` VARCHAR(300) NULL,
    `privacy_accepted_at` DATETIME(3) NOT NULL,
    `status` ENUM('PENDING', 'ACCEPTED', 'REJECTED') NOT NULL DEFAULT 'PENDING',
    `appointment_id` CHAR(36) NULL,
    `patient_id` CHAR(36) NULL,
    `decided_by_id` CHAR(36) NULL,
    `decided_at` DATETIME(3) NULL,
    `reject_reason` VARCHAR(300) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `booking_requests_reference_key`(`reference`),
    UNIQUE INDEX `booking_requests_appointment_id_key`(`appointment_id`),
    INDEX `booking_requests_clinic_id_status_created_at_idx`(`clinic_id`, `status`, `created_at`),
    INDEX `booking_requests_mobile_status_idx`(`mobile`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `booking_requests` ADD CONSTRAINT `booking_requests_branch_id_clinic_id_fkey` FOREIGN KEY (`branch_id`, `clinic_id`) REFERENCES `branches`(`id`, `clinic_id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `booking_requests` ADD CONSTRAINT `booking_requests_service_id_clinic_id_fkey` FOREIGN KEY (`service_id`, `clinic_id`) REFERENCES `agenda_services`(`id`, `clinic_id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `booking_requests` ADD CONSTRAINT `booking_requests_appointment_id_fkey` FOREIGN KEY (`appointment_id`) REFERENCES `appointments`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
