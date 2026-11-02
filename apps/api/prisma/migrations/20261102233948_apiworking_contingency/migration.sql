-- AlterTable
ALTER TABLE `apiworking_sales` ADD COLUMN `appointment_id` CHAR(36) NULL,
    ADD COLUMN `cash_movement_id` CHAR(36) NULL,
    ADD COLUMN `contingency` BOOLEAN NOT NULL DEFAULT false,
    MODIFY `doc_status` ENUM('PENDING_ISSUE', 'PENDING', 'SENT', 'REJECTED', 'PENDING_RECONCILIATION') NOT NULL DEFAULT 'PENDING';

-- CreateIndex
CREATE INDEX `apiworking_sales_appointment_id_idx` ON `apiworking_sales`(`appointment_id`);
