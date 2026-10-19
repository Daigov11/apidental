-- CreateTable
CREATE TABLE `cash_accounts` (
    `id` CHAR(36) NOT NULL,
    `clinic_id` CHAR(36) NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `kind` ENUM('CASH', 'CARD', 'YAPE_PLIN', 'TRANSFER', 'OTHER') NOT NULL,
    `allow_negative` BOOLEAN NOT NULL DEFAULT false,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `cash_accounts_clinic_id_name_key`(`clinic_id`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `cash_categories` (
    `id` CHAR(36) NOT NULL,
    `clinic_id` CHAR(36) NOT NULL,
    `flow` ENUM('INCOME', 'EXPENSE') NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `cash_categories_clinic_id_flow_name_key`(`clinic_id`, `flow`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `cash_registers` (
    `id` CHAR(36) NOT NULL,
    `clinic_id` CHAR(36) NOT NULL,
    `branch_id` CHAR(36) NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `cash_registers_clinic_id_idx`(`clinic_id`),
    UNIQUE INDEX `cash_registers_branch_id_key`(`branch_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `cash_sessions` (
    `id` CHAR(36) NOT NULL,
    `clinic_id` CHAR(36) NOT NULL,
    `register_id` CHAR(36) NOT NULL,
    `status` ENUM('OPEN', 'CLOSED') NOT NULL DEFAULT 'OPEN',
    `open_key` CHAR(36) NULL,
    `opened_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `opened_by_id` CHAR(36) NOT NULL,
    `open_notes` VARCHAR(300) NULL,
    `closed_at` DATETIME(3) NULL,
    `closed_by_id` CHAR(36) NULL,
    `close_notes` VARCHAR(300) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    UNIQUE INDEX `cash_sessions_open_key_key`(`open_key`),
    INDEX `cash_sessions_register_id_opened_at_idx`(`register_id`, `opened_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `cash_session_accounts` (
    `id` CHAR(36) NOT NULL,
    `session_id` CHAR(36) NOT NULL,
    `account_id` CHAR(36) NOT NULL,
    `opening_cents` INTEGER NOT NULL,
    `expected_cents` INTEGER NULL,
    `counted_cents` INTEGER NULL,
    `difference_cents` INTEGER NULL,

    UNIQUE INDEX `cash_session_accounts_session_id_account_id_key`(`session_id`, `account_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `cash_movements` (
    `id` CHAR(36) NOT NULL,
    `clinic_id` CHAR(36) NOT NULL,
    `register_id` CHAR(36) NOT NULL,
    `session_id` CHAR(36) NOT NULL,
    `account_id` CHAR(36) NOT NULL,
    `category_id` CHAR(36) NULL,
    `flow` ENUM('INCOME', 'EXPENSE') NOT NULL,
    `kind` ENUM('NORMAL', 'OPENING', 'COUNT_ADJUSTMENT') NOT NULL DEFAULT 'NORMAL',
    `description` VARCHAR(200) NOT NULL,
    `operation_number` VARCHAR(40) NULL,
    `amount_cents` INTEGER NOT NULL,
    `occurred_at` DATETIME(3) NOT NULL,
    `created_by_id` CHAR(36) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `status` ENUM('ACTIVE', 'VOIDED') NOT NULL DEFAULT 'ACTIVE',
    `voided_at` DATETIME(3) NULL,
    `voided_by_id` CHAR(36) NULL,
    `void_reason` VARCHAR(300) NULL,
    `request_key` CHAR(36) NULL,
    `operation_key` VARCHAR(130) NULL,

    UNIQUE INDEX `cash_movements_operation_key_key`(`operation_key`),
    INDEX `cash_movements_register_id_status_occurred_at_idx`(`register_id`, `status`, `occurred_at`),
    INDEX `cash_movements_session_id_idx`(`session_id`),
    INDEX `cash_movements_register_id_account_id_status_idx`(`register_id`, `account_id`, `status`),
    UNIQUE INDEX `cash_movements_clinic_id_request_key_key`(`clinic_id`, `request_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `cash_sessions` ADD CONSTRAINT `cash_sessions_register_id_fkey` FOREIGN KEY (`register_id`) REFERENCES `cash_registers`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cash_session_accounts` ADD CONSTRAINT `cash_session_accounts_session_id_fkey` FOREIGN KEY (`session_id`) REFERENCES `cash_sessions`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cash_session_accounts` ADD CONSTRAINT `cash_session_accounts_account_id_fkey` FOREIGN KEY (`account_id`) REFERENCES `cash_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cash_movements` ADD CONSTRAINT `cash_movements_register_id_fkey` FOREIGN KEY (`register_id`) REFERENCES `cash_registers`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cash_movements` ADD CONSTRAINT `cash_movements_session_id_fkey` FOREIGN KEY (`session_id`) REFERENCES `cash_sessions`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cash_movements` ADD CONSTRAINT `cash_movements_account_id_fkey` FOREIGN KEY (`account_id`) REFERENCES `cash_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cash_movements` ADD CONSTRAINT `cash_movements_category_id_fkey` FOREIGN KEY (`category_id`) REFERENCES `cash_categories`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;


-- Montos siempre positivos (el signo lo da flow) y acotados.
ALTER TABLE `cash_movements` ADD CONSTRAINT `cash_movements_amount_chk` CHECK (`amount_cents` > 0 AND `amount_cents` <= 100000000);
