-- AlterTable
ALTER TABLE `agenda_services` ADD COLUMN `price_cents` INTEGER NULL;

-- CreateTable
CREATE TABLE `charges` (
    `id` CHAR(36) NOT NULL,
    `clinic_id` CHAR(36) NOT NULL,
    `branch_id` CHAR(36) NOT NULL,
    `patient_id` CHAR(36) NOT NULL,
    `appointment_id` CHAR(36) NULL,
    `appointment_key` CHAR(36) NULL,
    `description` VARCHAR(200) NOT NULL,
    `amount_cents` INTEGER NOT NULL,
    `currency` CHAR(3) NOT NULL DEFAULT 'PEN',
    `status` ENUM('PENDING', 'PAID', 'VOIDED') NOT NULL DEFAULT 'PENDING',
    `payment_method` ENUM('CASH', 'CARD', 'YAPE_PLIN', 'TRANSFER') NULL,
    `paid_at` DATETIME(3) NULL,
    `paid_by_id` CHAR(36) NULL,
    `void_reason` VARCHAR(300) NULL,
    `created_by_id` CHAR(36) NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `charges_appointment_key_key`(`appointment_key`),
    INDEX `charges_clinic_id_status_created_at_idx`(`clinic_id`, `status`, `created_at`),
    INDEX `charges_patient_id_created_at_idx`(`patient_id`, `created_at`),
    UNIQUE INDEX `charges_id_clinic_id_key`(`id`, `clinic_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `billing_documents` (
    `id` CHAR(36) NOT NULL,
    `clinic_id` CHAR(36) NOT NULL,
    `charge_id` CHAR(36) NOT NULL,
    `type` ENUM('BOLETA', 'FACTURA') NOT NULL,
    `series` VARCHAR(8) NOT NULL,
    `number` INTEGER NOT NULL,
    `status` ENUM('PENDING_SEND', 'SENT', 'ISSUED', 'REJECTED', 'RETRYABLE_ERROR', 'NEEDS_RECONCILIATION') NOT NULL DEFAULT 'PENDING_SEND',
    `customer_name` VARCHAR(200) NOT NULL,
    `customer_doc_type` VARCHAR(10) NOT NULL,
    `customer_doc_number` VARCHAR(20) NOT NULL,
    `amount_cents` INTEGER NOT NULL,
    `igv_cents` INTEGER NOT NULL,
    `demo_mark` VARCHAR(60) NOT NULL,
    `idempotency_key` VARCHAR(100) NOT NULL,
    `active_key` CHAR(36) NULL,
    `provider_ref` VARCHAR(80) NULL,
    `rejection_reason` VARCHAR(300) NULL,
    `scenario` VARCHAR(20) NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `last_attempt_at` DATETIME(3) NULL,
    `issued_at` DATETIME(3) NULL,
    `created_by_id` CHAR(36) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `billing_documents_idempotency_key_key`(`idempotency_key`),
    UNIQUE INDEX `billing_documents_active_key_key`(`active_key`),
    INDEX `billing_documents_clinic_id_status_idx`(`clinic_id`, `status`),
    UNIQUE INDEX `billing_documents_clinic_id_series_number_key`(`clinic_id`, `series`, `number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `billing_counters` (
    `clinic_id` CHAR(36) NOT NULL,
    `series` VARCHAR(8) NOT NULL,
    `last` INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY (`clinic_id`, `series`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `integration_outbox` (
    `id` CHAR(36) NOT NULL,
    `clinic_id` CHAR(36) NOT NULL,
    `kind` ENUM('BILLING_EMIT', 'LOYALTY_ACCRUE', 'REVIEW_REQUEST') NOT NULL,
    `aggregate_type` VARCHAR(40) NOT NULL,
    `aggregate_id` CHAR(36) NOT NULL,
    `idempotency_key` VARCHAR(100) NOT NULL,
    `status` ENUM('PENDING', 'DONE', 'FAILED', 'SKIPPED') NOT NULL DEFAULT 'PENDING',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `next_attempt_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `note` VARCHAR(300) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `processed_at` DATETIME(3) NULL,

    UNIQUE INDEX `integration_outbox_idempotency_key_key`(`idempotency_key`),
    INDEX `integration_outbox_status_next_attempt_at_idx`(`status`, `next_attempt_at`),
    INDEX `integration_outbox_clinic_id_status_idx`(`clinic_id`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `mock_provider_records` (
    `idempotency_key` VARCHAR(100) NOT NULL,
    `kind` VARCHAR(20) NOT NULL,
    `state` VARCHAR(20) NOT NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `result` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`idempotency_key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `mock_loyalty_entries` (
    `id` CHAR(36) NOT NULL,
    `clinic_id` CHAR(36) NOT NULL,
    `patient_ref` CHAR(36) NOT NULL,
    `kind` VARCHAR(12) NOT NULL,
    `points` INTEGER NOT NULL,
    `reason` VARCHAR(200) NULL,
    `idempotency_key` VARCHAR(100) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `mock_loyalty_entries_idempotency_key_key`(`idempotency_key`),
    INDEX `mock_loyalty_entries_clinic_id_patient_ref_created_at_idx`(`clinic_id`, `patient_ref`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `mock_review_requests` (
    `id` CHAR(36) NOT NULL,
    `clinic_id` CHAR(36) NOT NULL,
    `patient_ref` CHAR(36) NOT NULL,
    `idempotency_key` VARCHAR(100) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `mock_review_requests_idempotency_key_key`(`idempotency_key`),
    INDEX `mock_review_requests_clinic_id_created_at_idx`(`clinic_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `charges` ADD CONSTRAINT `charges_patient_id_clinic_id_fkey` FOREIGN KEY (`patient_id`, `clinic_id`) REFERENCES `patients`(`id`, `clinic_id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `billing_documents` ADD CONSTRAINT `billing_documents_charge_id_clinic_id_fkey` FOREIGN KEY (`charge_id`, `clinic_id`) REFERENCES `charges`(`id`, `clinic_id`) ON DELETE RESTRICT ON UPDATE CASCADE;


-- ===================================================================================================
-- Reglas de integridad (cobros y comprobantes SIMULADOS)
-- ===================================================================================================
ALTER TABLE `agenda_services` ADD CONSTRAINT `agenda_services_price_chk` CHECK (`price_cents` IS NULL OR (`price_cents` > 0 AND `price_cents` <= 100000000));
ALTER TABLE `charges` ADD CONSTRAINT `charges_amount_chk` CHECK (`amount_cents` > 0 AND `amount_cents` <= 100000000);
ALTER TABLE `charges` ADD CONSTRAINT `charges_state_chk` CHECK (
  (`status` = 'PAID' AND `paid_at` IS NOT NULL AND `payment_method` IS NOT NULL)
  OR (`status` = 'PENDING' AND `paid_at` IS NULL)
  OR (`status` = 'VOIDED' AND `void_reason` IS NOT NULL)
);
ALTER TABLE `billing_documents` ADD CONSTRAINT `billing_documents_amount_chk` CHECK (`amount_cents` > 0 AND `igv_cents` >= 0 AND `igv_cents` < `amount_cents`);
-- Todo comprobante lleva la marca visible; la base de datos impide guardar uno sin ella.
ALTER TABLE `billing_documents` ADD CONSTRAINT `billing_documents_demo_mark_chk` CHECK (`demo_mark` = 'DEMO — NO VÁLIDO PARA SUNAT');
ALTER TABLE `billing_documents` ADD CONSTRAINT `billing_documents_state_chk` CHECK (
  (`status` = 'ISSUED' AND `issued_at` IS NOT NULL AND `provider_ref` IS NOT NULL)
  OR (`status` = 'REJECTED' AND `rejection_reason` IS NOT NULL)
  OR `status` IN ('PENDING_SEND', 'SENT', 'RETRYABLE_ERROR', 'NEEDS_RECONCILIATION')
);
ALTER TABLE `mock_loyalty_entries` ADD CONSTRAINT `mock_loyalty_points_chk` CHECK (`points` > 0);

-- Cobro: el monto y los datos de origen no cambian; PAGADO y ANULADO son definitivos; no se elimina.
CREATE TRIGGER `charges_guard_update`
  BEFORE UPDATE ON `charges` FOR EACH ROW
BEGIN
  IF NOT (NEW.`clinic_id` <=> OLD.`clinic_id`) OR NOT (NEW.`patient_id` <=> OLD.`patient_id`) OR NOT (NEW.`branch_id` <=> OLD.`branch_id`)
     OR NOT (NEW.`amount_cents` <=> OLD.`amount_cents`) OR NOT (NEW.`description` <=> OLD.`description`)
     OR NOT (NEW.`appointment_id` <=> OLD.`appointment_id`) OR NOT (NEW.`created_by_id` <=> OLD.`created_by_id`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'charges: el monto, el paciente y el origen del cobro son inmutables';
  END IF;
  IF OLD.`status` IN ('PAID', 'VOIDED') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'charges: un cobro pagado o anulado no se modifica';
  END IF;
END;

CREATE TRIGGER `charges_block_delete`
  BEFORE DELETE ON `charges` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'charges: los cobros no se eliminan; se anulan';
END;

-- Comprobante: núcleo inmutable; EMITIDO y RECHAZADO son definitivos; no se elimina.
CREATE TRIGGER `billing_documents_guard_update`
  BEFORE UPDATE ON `billing_documents` FOR EACH ROW
BEGIN
  IF NOT (NEW.`clinic_id` <=> OLD.`clinic_id`) OR NOT (NEW.`charge_id` <=> OLD.`charge_id`) OR NOT (NEW.`type` <=> OLD.`type`)
     OR NOT (NEW.`series` <=> OLD.`series`) OR NOT (NEW.`number` <=> OLD.`number`) OR NOT (NEW.`amount_cents` <=> OLD.`amount_cents`)
     OR NOT (NEW.`igv_cents` <=> OLD.`igv_cents`) OR NOT (NEW.`customer_name` <=> OLD.`customer_name`)
     OR NOT (NEW.`customer_doc_type` <=> OLD.`customer_doc_type`) OR NOT (NEW.`customer_doc_number` <=> OLD.`customer_doc_number`)
     OR NOT (NEW.`demo_mark` <=> OLD.`demo_mark`) OR NOT (NEW.`idempotency_key` <=> OLD.`idempotency_key`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'billing_documents: el contenido del comprobante es inmutable';
  END IF;
  IF OLD.`status` IN ('ISSUED', 'REJECTED') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'billing_documents: un comprobante emitido o rechazado no se modifica';
  END IF;
END;

CREATE TRIGGER `billing_documents_block_delete`
  BEFORE DELETE ON `billing_documents` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'billing_documents: los comprobantes no se eliminan';
END;
