-- Cerrar un procedimiento es un evento normal del flujo, no una corrección: no exige motivo.
-- Corregir, rectificar, cancelar o marcar por error siguen exigiéndolo.
DROP TRIGGER `clinical_procedures_insert_chain`;

CREATE TRIGGER `clinical_procedures_insert_chain`
  BEFORE INSERT ON `clinical_procedures` FOR EACH ROW
BEGIN
  IF NEW.`version` > 1 AND NEW.`change_kind` <> 'CLOSED' AND CHAR_LENGTH(TRIM(COALESCE(NEW.`change_reason`, ''))) < 3 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_procedures: todo cambio posterior al alta, salvo el cierre, exige un motivo de al menos 3 caracteres';
  END IF;
  IF NEW.`version` = 1 AND NEW.`change_reason` IS NOT NULL AND CHAR_LENGTH(TRIM(NEW.`change_reason`)) < 3 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_procedures: si se informa un motivo debe tener al menos 3 caracteres';
  END IF;
  IF NEW.`current_key` IS NULL OR NEW.`current_key` <> NEW.`item_id` THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_procedures: una versión nueva nace como la vigente del elemento';
  END IF;
  IF NEW.`version` = 1 THEN
    IF NEW.`supersedes_id` IS NOT NULL OR NEW.`change_kind` <> 'CREATED' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_procedures: la versión 1 es el alta del elemento';
    END IF;
    IF (SELECT v.`status` FROM `clinical_visits` v WHERE v.`id` = NEW.`visit_id`) <> 'OPEN' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_procedures: solo se registran elementos nuevos en una visita abierta';
    END IF;
  ELSE
    IF NEW.`change_kind` = 'CREATED' OR NEW.`supersedes_id` IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_procedures: las versiones posteriores reemplazan a la anterior';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM `clinical_procedures` p
      WHERE p.`id` = NEW.`supersedes_id` AND p.`item_id` = NEW.`item_id` AND p.`version` = NEW.`version` - 1
        AND p.`patient_id` = NEW.`patient_id` AND p.`clinic_id` = NEW.`clinic_id` AND p.`visit_id` = NEW.`visit_id` AND p.`definition_id` = NEW.`definition_id` AND p.`dentist_user_id` = NEW.`dentist_user_id` AND p.`definition_code` = NEW.`definition_code`
    ) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_procedures: la versión debe continuar la anterior del mismo elemento, visita y paciente';
    END IF;
  END IF;
  IF NEW.`change_kind` = 'CREATED' AND (NEW.`status` <> 'OPEN' OR NEW.`closed_at` IS NOT NULL OR NEW.`closure_consent` IS NOT NULL) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_procedures: un procedimiento nace abierto';
  END IF;
  IF NEW.`change_kind` = 'CLOSED' THEN
    IF NEW.`status` <> 'CLOSED' OR NEW.`closed_at` IS NULL OR NEW.`closure_consent` IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_procedures: cerrar exige fecha y el consentimiento verificado';
    END IF;
    IF (SELECT v.`status` FROM `clinical_visits` v WHERE v.`id` = NEW.`visit_id`) <> 'OPEN' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_procedures: solo se cierra un procedimiento en una visita abierta';
    END IF;
    -- Consentimiento clínico: si el catálogo lo exige, debe haber uno vigente (defensa en profundidad).
    IF (SELECT d.`requires_clinical_consent` FROM `procedure_definitions` d WHERE d.`id` = NEW.`definition_id`) = 1
       AND NOT EXISTS (SELECT 1 FROM `patient_consents` c WHERE c.`patient_id` = NEW.`patient_id` AND c.`clinic_id` = NEW.`clinic_id` AND c.`type` = 'CLINICAL' AND c.`status` = 'GRANTED') THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_procedures: el procedimiento requiere consentimiento clínico vigente';
    END IF;
  END IF;
  IF NEW.`change_kind` = 'CANCELLED' AND NEW.`status` <> 'CANCELLED' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_procedures: estado incoherente con la cancelación';
  END IF;
  IF NEW.`change_kind` = 'MARKED_IN_ERROR' AND NEW.`status` <> 'ENTERED_IN_ERROR' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'clinical_procedures: estado incoherente con el registro por error';
  END IF;
END;
