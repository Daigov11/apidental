-- CreateTable
CREATE TABLE `apiworking_customers` (
    `id` CHAR(36) NOT NULL,
    `clinic_id` CHAR(36) NOT NULL,
    `tenant` VARCHAR(120) NOT NULL,
    `external_customer_id` VARCHAR(40) NOT NULL,
    `doc_type` VARCHAR(2) NOT NULL,
    `doc_number` VARCHAR(20) NOT NULL,
    `name` VARCHAR(200) NOT NULL,
    `created_by_id` CHAR(36) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `apiworking_customers_clinic_id_name_idx`(`clinic_id`, `name`),
    UNIQUE INDEX `apiworking_customers_tenant_external_customer_id_key`(`tenant`, `external_customer_id`),
    UNIQUE INDEX `apiworking_customers_tenant_doc_type_doc_number_key`(`tenant`, `doc_type`, `doc_number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
