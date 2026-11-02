-- CreateTable
CREATE TABLE `external_identities` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `provider` VARCHAR(20) NOT NULL,
    `tenant` VARCHAR(120) NOT NULL,
    `external_user_id` VARCHAR(40) NOT NULL,
    `external_username` VARCHAR(120) NOT NULL,
    `external_branch_id` VARCHAR(40) NULL,
    `external_roles` JSON NULL,
    `last_login_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `external_identities_user_id_key`(`user_id`),
    UNIQUE INDEX `external_identities_provider_tenant_external_user_id_key`(`provider`, `tenant`, `external_user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `apiworking_sales` (
    `id` CHAR(36) NOT NULL,
    `clinic_id` CHAR(36) NOT NULL,
    `tenant` VARCHAR(120) NOT NULL,
    `idempotency_key` VARCHAR(64) NOT NULL,
    `request_hash` CHAR(64) NOT NULL,
    `patient_id` CHAR(36) NULL,
    `external_customer_id` VARCHAR(40) NOT NULL,
    `customer_name` VARCHAR(200) NOT NULL,
    `customer_doc_type` VARCHAR(20) NOT NULL,
    `customer_doc_number` VARCHAR(20) NOT NULL,
    `id_caja` VARCHAR(40) NOT NULL,
    `id_serie` VARCHAR(40) NOT NULL,
    `serie` VARCHAR(20) NULL,
    `document_type_id` VARCHAR(40) NOT NULL,
    `payment_method_id` VARCHAR(40) NOT NULL,
    `description` VARCHAR(200) NOT NULL,
    `lines` JSON NOT NULL,
    `total_cents` INTEGER NOT NULL,
    `doc_date` DATE NOT NULL,
    `doc_status` ENUM('PENDING', 'SENT', 'REJECTED', 'PENDING_RECONCILIATION') NOT NULL DEFAULT 'PENDING',
    `payment_status` ENUM('NO_EVIDENCE', 'CONFIRMED_REMOTE', 'CONFIRMED_RECONCILED') NOT NULL DEFAULT 'NO_EVIDENCE',
    `void_status` ENUM('IN_PROGRESS', 'VOIDED', 'TO_RECONCILE') NULL,
    `external_doc_id` VARCHAR(40) NULL,
    `external_number` VARCHAR(40) NULL,
    `failure_reason` VARCHAR(300) NULL,
    `attempted_at` DATETIME(3) NULL,
    `created_by_id` CHAR(36) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `apiworking_sales_idempotency_key_key`(`idempotency_key`),
    INDEX `apiworking_sales_clinic_id_created_at_idx`(`clinic_id`, `created_at`),
    INDEX `apiworking_sales_tenant_attempted_at_idx`(`tenant`, `attempted_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `external_identities` ADD CONSTRAINT `external_identities_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
