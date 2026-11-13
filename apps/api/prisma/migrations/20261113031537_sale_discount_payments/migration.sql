-- AlterTable
ALTER TABLE `apiworking_sales` ADD COLUMN `discount_cents` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `payments` JSON NULL;
