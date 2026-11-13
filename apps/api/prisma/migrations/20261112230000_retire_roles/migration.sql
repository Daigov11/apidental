-- La clínica trabaja solo con Administrador, Cajero y Odontólogo.
--  1. El Cajero hace la recepción: agenda citas y registra pacientes (patient:write, appointment:manage); sigue con la vista mínima.
--     Sigue sin ningún acceso clínico.
--     (El catálogo en código, prisma/catalog.ts, ya lo define así: db:seed deja el mismo resultado.)
--  2. Las asignaciones ACTIVAS de Recepcionista pasan a Cajero (misma clínica y sede). Si la persona ya era Cajero en ese
--     alcance, la de Recepcionista solo se desactiva.
--  3. Las asignaciones activas de Asistente y Director Clínico se desactivan (no se borran: quedan en el historial).
-- En una base nueva (sin roles todavía) no hace nada.

SET @cashier := (SELECT `id` FROM `roles` WHERE `code` = 'CASHIER');
SET @recep := (SELECT `id` FROM `roles` WHERE `code` = 'RECEPTIONIST');

INSERT IGNORE INTO `role_permissions` (`role_id`, `permission_id`)
SELECT @cashier, p.`id`
FROM `permissions` p
WHERE @cashier IS NOT NULL AND p.`code` IN ('patient:write', 'appointment:manage');

UPDATE `user_assignments` ua
JOIN (SELECT `assignment_key` FROM `user_assignments`) existing
  ON existing.`assignment_key` = CONCAT(ua.`user_id`, '|', @cashier, '|', COALESCE(ua.`clinic_id`, '*'), '|', COALESCE(ua.`branch_id`, '*'))
SET ua.`status` = 'INACTIVE'
WHERE ua.`role_id` = @recep AND ua.`status` = 'ACTIVE';

UPDATE `user_assignments`
SET `role_id` = @cashier,
    `assignment_key` = CONCAT(`user_id`, '|', @cashier, '|', COALESCE(`clinic_id`, '*'), '|', COALESCE(`branch_id`, '*'))
WHERE @cashier IS NOT NULL AND `role_id` = @recep AND `status` = 'ACTIVE';

UPDATE `user_assignments`
SET `status` = 'INACTIVE'
WHERE `status` = 'ACTIVE' AND `role_id` IN (SELECT `id` FROM (SELECT `id` FROM `roles` WHERE `code` IN ('ASSISTANT', 'CLINICAL_DIRECTOR')) r);
