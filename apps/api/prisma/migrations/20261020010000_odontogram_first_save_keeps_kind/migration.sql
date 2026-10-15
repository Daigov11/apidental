-- Guardar el primer borrador (tipo CREATED) conserva su tipo: la versión guardada del primer odontograma es CREATED.
DROP TRIGGER `clinical_odontograms_insert_chain`;

CREATE TRIGGER `clinical_odontograms_insert_chain`
  BEFORE INSERT ON `clinical_odontograms` FOR EACH ROW
BEGIN
  DECLARE prev_status VARCHAR(20);
  DECLARE prev_kind VARCHAR(20);
  IF NEW.`current_key` IS NULL OR NEW.`current_key` <> NEW.`patient_id` THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_odontograms: una versión nueva nace como la vigente de la cadena del paciente';
  END IF;
  IF NEW.`status` = 'DRAFT' AND (NEW.`revision` <> 0 OR NEW.`content_hash` IS NOT NULL OR NEW.`closed_at` IS NOT NULL OR NEW.`reauth_proof_id` IS NOT NULL) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_odontograms: un borrador nace sin datos de cierre';
  END IF;
  -- motivo: obligatorio al corregir, rectificar, descartar o marcar por error; opcional en el alta y en la actualización.
  IF NEW.`change_kind` IN ('CORRECTED', 'RECTIFIED', 'DISCARDED', 'MARKED_IN_ERROR') AND CHAR_LENGTH(TRIM(COALESCE(NEW.`change_reason`, ''))) < 3 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_odontograms: corregir, rectificar, descartar o marcar por error exige un motivo de al menos 3 caracteres';
  END IF;
  IF NEW.`change_reason` IS NOT NULL AND CHAR_LENGTH(TRIM(NEW.`change_reason`)) < 3 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_odontograms: si se informa un motivo debe tener al menos 3 caracteres';
  END IF;
  IF NEW.`version` = 1 THEN
    IF NEW.`supersedes_id` IS NOT NULL OR NEW.`change_kind` <> 'CREATED' OR NEW.`status` <> 'DRAFT' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_odontograms: la versión 1 es el borrador inicial';
    END IF;
  ELSE
    IF NEW.`supersedes_id` IS NULL OR (NEW.`change_kind` = 'CREATED' AND NEW.`status` <> 'CLOSED') THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_odontograms: las versiones posteriores reemplazan a la anterior';
    END IF;
    SELECT p.`status`, p.`change_kind` INTO prev_status, prev_kind FROM `clinical_odontograms` p
     WHERE p.`id` = NEW.`supersedes_id` AND p.`version` = NEW.`version` - 1 AND p.`patient_id` = NEW.`patient_id` AND p.`clinic_id` = NEW.`clinic_id`;
    IF prev_status IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_odontograms: la versión debe continuar la anterior del mismo paciente';
    END IF;
    -- borrador -> guardada | descartada; guardada -> borrador nuevo | por error; descartada o por error -> borrador nuevo.
    IF NOT ((prev_status = 'DRAFT' AND NEW.`status` IN ('CLOSED', 'DISCARDED'))
         OR (prev_status = 'CLOSED' AND NEW.`status` IN ('DRAFT', 'ENTERED_IN_ERROR'))
         OR (prev_status IN ('DISCARDED', 'ENTERED_IN_ERROR') AND NEW.`status` = 'DRAFT')) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_odontograms: transición de estado no permitida';
    END IF;
    IF NEW.`status` = 'DRAFT' AND NEW.`change_kind` NOT IN ('UPDATED', 'CORRECTED', 'RECTIFIED') THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_odontograms: un borrador nuevo es una actualización, corrección o rectificación';
    END IF;
    IF NEW.`status` = 'CLOSED' AND (NEW.`change_kind` <> prev_kind OR NEW.`content_hash` IS NULL OR NEW.`closed_at` IS NULL) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_odontograms: guardar la versión conserva el tipo del borrador y exige huella de integridad y fecha';
    END IF;
    -- Corregir o rectificar exige reautenticación al guardar la versión; marcar por error, también.
    IF NEW.`status` = 'CLOSED' AND NEW.`change_kind` IN ('CORRECTED', 'RECTIFIED') AND NEW.`reauth_proof_id` IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_odontograms: corregir o rectificar exige reautenticación';
    END IF;
    IF NEW.`status` = 'ENTERED_IN_ERROR' AND (NEW.`change_kind` <> 'MARKED_IN_ERROR' OR NEW.`reauth_proof_id` IS NULL) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_odontograms: marcar por error exige reautenticación';
    END IF;
    IF NEW.`status` = 'DISCARDED' AND NEW.`change_kind` <> 'DISCARDED' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_odontograms: estado incoherente con el descarte';
    END IF;
  END IF;
END;
