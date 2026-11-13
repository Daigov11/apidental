-- AlterTable
ALTER TABLE `products` ADD COLUMN `kind` ENUM('PRODUCT', 'SERVICE') NOT NULL DEFAULT 'PRODUCT';

-- CreateTable
CREATE TABLE `visit_services` (
    `id` CHAR(36) NOT NULL,
    `clinic_id` CHAR(36) NOT NULL,
    `patient_id` CHAR(36) NOT NULL,
    `visit_id` CHAR(36) NOT NULL,
    `product_id` CHAR(36) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `unit_price_cents` INTEGER NOT NULL,
    `teeth` JSON NOT NULL,
    `quantity` INTEGER NOT NULL,
    `status` ENUM('ACTIVE', 'REMOVED') NOT NULL DEFAULT 'ACTIVE',
    `sale_id` CHAR(36) NULL,
    `created_by_id` CHAR(36) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `removed_at` DATETIME(3) NULL,

    INDEX `visit_services_clinic_id_patient_id_status_sale_id_idx`(`clinic_id`, `patient_id`, `status`, `sale_id`),
    INDEX `visit_services_visit_id_idx`(`visit_id`),
    INDEX `visit_services_sale_id_idx`(`sale_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `visit_services` ADD CONSTRAINT `visit_services_visit_id_fkey` FOREIGN KEY (`visit_id`) REFERENCES `clinical_visits`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `visit_services` ADD CONSTRAINT `visit_services_product_id_fkey` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
