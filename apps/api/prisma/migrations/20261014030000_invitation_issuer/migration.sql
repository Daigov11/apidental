-- AlterTable
ALTER TABLE `invitations` ADD COLUMN `issued_by_platform` BOOLEAN NOT NULL DEFAULT false;


-- Quién emitió la invitación tampoco puede alterarse después: se recrea el trigger de inmutabilidad.
DROP TRIGGER `invitations_immutable_target`;

CREATE TRIGGER `invitations_immutable_target`
  BEFORE UPDATE ON `invitations` FOR EACH ROW
BEGIN
  IF NOT (NEW.`email` <=> OLD.`email`)
     OR NOT (NEW.`role_id` <=> OLD.`role_id`)
     OR NOT (NEW.`clinic_id` <=> OLD.`clinic_id`)
     OR NOT (NEW.`branch_id` <=> OLD.`branch_id`)
     OR NOT (NEW.`created_by_id` <=> OLD.`created_by_id`)
     OR NOT (NEW.`issued_by_platform` <=> OLD.`issued_by_platform`)
     OR NOT (NEW.`provisioning_record_id` <=> OLD.`provisioning_record_id`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'invitations: destinatario, rol y alcance son inmutables';
  END IF;
  IF OLD.`status` <> 'PENDING' AND NEW.`status` <> OLD.`status` THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'invitations: una invitación cerrada no cambia de estado';
  END IF;
END;
