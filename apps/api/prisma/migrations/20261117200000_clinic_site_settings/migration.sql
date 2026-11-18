-- Página pública personalizable por clínica: textos y secciones (JSON) y logo propio.
ALTER TABLE `clinics`
  ADD COLUMN `site_settings` JSON NULL,
  ADD COLUMN `site_logo` MEDIUMBLOB NULL,
  ADD COLUMN `site_logo_type` VARCHAR(40) NULL,
  ADD COLUMN `site_logo_updated_at` DATETIME(3) NULL;
