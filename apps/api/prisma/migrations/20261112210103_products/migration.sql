-- CreateTable
CREATE TABLE `products` (
    `id` CHAR(36) NOT NULL,
    `clinic_id` CHAR(36) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `presentation` VARCHAR(80) NULL,
    `price_cents` INTEGER NOT NULL,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `products_clinic_id_status_idx`(`clinic_id`, `status`),
    UNIQUE INDEX `products_clinic_id_name_key`(`clinic_id`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `products` ADD CONSTRAINT `products_clinic_id_fkey` FOREIGN KEY (`clinic_id`) REFERENCES `clinics`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
