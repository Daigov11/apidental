# Incremento 1: fundación técnica (autenticación, tenancy y RBAC)

Complementa a [`mvp-p0-apidental.md`](mvp-p0-apidental.md). Describe lo **realmente implementado**, los supuestos tomados y las limitaciones conocidas.

## Alcance entregado

API NestJS (`apps/api`) con Prisma + MySQL: Clinic, Branch, User, Role, Permission, RolePermission, UserAssignment y AuditLog; autenticación JWT; autorización por contexto clínica/sede/rol; auditoría; health check; seed; comando de bootstrap del primer administrador; pruebas unitarias y e2e.

Fuera de alcance, sin tablas ni endpoints: pacientes, historia clínica, agenda, odontograma, pagos, inventario, comprobantes e integración con Apiworking.

## Decisiones de diseño

| Tema | Decisión | Motivo |
|---|---|---|
| Fuente de permisos | Solo `UserAssignment` (usuario + rol + clínica + sede). El token **no** lleva permisos. | Revocar una asignación o deshabilitar un usuario debe surtir efecto de inmediato. Cuesta ~2 consultas por solicitud, aceptable en este tamaño. |
| Login y contexto | `login` devuelve un token **sin contexto**; `select-context` valida contra las asignaciones y emite un token con `ctx {clinicId, branchId}`. | Un usuario puede trabajar en varias clínicas/sedes (odontólogos). El contexto activo es siempre explícito y validado. |
| Significado de NULL en la asignación | Clínica nula = alcance de plataforma (solo roles `PLATFORM`). Sede nula = toda la clínica (solo roles `CLINIC`). Con sede, rige esa sede + las asignaciones de toda la clínica. | Se hace explícito en el servicio y se refuerza en BD con un CHECK y una FK compuesta `(branch_id, clinic_id)`. |
| Unicidad de asignaciones | Columna `assignment_key` determinista. | MySQL trata los NULL como distintos en índices únicos; sin esto habría asignaciones duplicadas. |
| Anti-escalada | Un rol solo se otorga si el otorgante tiene todos sus permisos en su contexto; una clínica no otorga roles de plataforma ni fuera de su clínica; con contexto fijado a una sede, solo en esa sede. | Evita que un administrador se otorgue o delegue más poder del que tiene. |
| Auditoría | Tabla sin claves foráneas, escritura solo por `AuditService`, triggers BEFORE UPDATE/DELETE que abortan. Las mutaciones administrativas auditan **en la misma transacción**; los fallos de login auditan sin tumbar la solicitud. | Inmutabilidad real y trazabilidad atómica. |
| `passwordHash` | `omit` a nivel de cliente Prisma; solo `login` lo pide explícitamente. | Defensa en profundidad: una consulta nueva no filtra el hash por descuido. |
| Mensajes de login | Un único `Credenciales inválidas`, hash de relleno cuando el usuario no existe. | Evita enumeración de usuarios por mensaje y por tiempo. |
| Configuración | Clase `AppConfig` validada con class-validator al arrancar; sin `@nestjs/config`. | Falla temprano, tipado, una dependencia menos. |
| Versionado | Prefijo global `/v1`. | Simple y reversible. |
| Pruebas | Vitest (plantilla oficial de Nest 12) con e2e contra una base real `*_test` recreada en cada ejecución. | Las migraciones, triggers y restricciones forman parte de lo que se prueba. |

## Desviaciones y supuestos (reversibles)

1. **Sin refresh token ni logout (RESUELTO en 3.0: ver [`incremento-3-0-acceso-seguro.md`](incremento-3-0-acceso-seguro.md)).** Lo permitía el alcance y la estrategia final de cookies entre `dental.apiworking.com.pe` y `api.dental...` sigue sin confirmar. El access token vive 15 min; el cierre de sesión es descartar el token en el cliente. La revocación inmediata se logra deshabilitando al usuario o revocando asignaciones (se comprueban en cada solicitud). **Pendiente:** definir refresh rotativo (documento de arquitectura, 8.1).
2. **Sin recuperación ni cambio de contraseña.** En 3.0 el administrador **dejó de fijar contraseñas** (alta solo por invitación; `POST /v1/users` se eliminó), pero la **recuperación de contraseña** quedó resuelta en 3.0 (`POST /v1/auth/password-recovery`, ver `incremento-3-0-acceso-seguro.md`); falta la notificación de “contraseña cambiada”.
3. **Sin Swagger/OpenAPI.** Se difiere; la tabla de endpoints está en el README.
4. **RBAC inicial fijo.** Permisos por rol definidos en código y sincronizados por el seed; no editables por clínica. No existe ningún permiso clínico: ni siquiera el administrador de plataforma puede leer datos clínicos futuros, y esa política **debe decidirse explícitamente** cuando haya módulos clínicos (documento de arquitectura, sección 11, puntos 5 y 11).
5. **`POST /v1/assignments` acepta cualquier `userId`.** Un administrador de clínica puede asignar a su clínica a un usuario existente de otra; la respuesta 404 vs 201 revela si un id existe. Con UUIDs no adivinables el riesgo es bajo; se revisará al introducir invitaciones.
6. **Un administrador no puede revocar sus propias asignaciones** (evita el auto-bloqueo), pero otro administrador sí podría dejar a la clínica sin administradores. La regla de "último administrador" se implementó en 3.0 (también al deshabilitar usuarios).
7. **RUC:** solo se valida el formato de 11 dígitos; no se valida contra SUNAT (por validar).
8. **Zona horaria:** las fechas se guardan en UTC; la conversión a `America/Lima` es responsabilidad de la presentación.
9. **IP del cliente:** `req.ip` solo es fiable con `TRUST_PROXY=1` detrás de Nginx; sin él, el límite de tasa y la auditoría verán la IP del proxy.

## Verificación realizada

### Validación estricta contra MySQL 8.4 (2026-10-14)

Motor real: **MySQL Community Server 8.4.6** (imagen `mysql:8.4.6` de `docker-compose.dev.yml`), `utf8mb4`, binlog activo. Se destruyó el contenedor y el volumen del proyecto y se repitió todo desde cero.

| Comprobación | Resultado |
|---|---|
| Versión real del motor (`SELECT VERSION()`, `@@version_comment`) | 8.4.6, MySQL Community Server - GPL |
| Bases `apidental_dev/_test/_shadow` creadas por `docker/mysql-init` | Correcto |
| `prisma migrate deploy` desde cero y `migrate dev` (base sombra) | Correcto; sin desvío con el schema |
| Seed (dos ejecuciones) | Idempotente |
| Pruebas e2e (7 archivos, base `_test` recién creada) | **74 de 74** |
| Pruebas unitarias | 31 de 31 |
| `tsc --noEmit`, `oxlint --type-aware`, `nest build` | Sin errores |
| `npm audit` | 0 vulnerabilidades |

Garantías comprobadas específicamente en MySQL 8.4 (`test/mysql-engine.e2e-spec.ts` y `test/db-constraints.e2e-spec.ts`):

- **Triggers de `audit_logs`:** existen exactamente `BEFORE UPDATE` y `BEFORE DELETE`; UPDATE, DELETE y DELETE masivo son rechazados.
- **CHECK** `user_assignments_branch_requires_clinic_chk`: presente y `ENFORCED = YES`; rechaza sede sin clínica.
- **FK compuesta** `(branch_id, clinic_id) → branches(id, clinic_id)`: de 2 columnas, `RESTRICT`; rechaza sede con clínica equivocada.
- **JSON:** `audit_logs.summary` es de tipo `json` nativo; ida y vuelta exacta con tildes, símbolos y anidados; `JSON_EXTRACT` funciona; no se guardan claves sensibles.
- **Aislamiento clínica/sede:** todos los casos de `tenancy`, `users` y `auth` pasan.
- **Base de pruebas:** se crea por el script de inicio y la suite la migra y vacía en cada ejecución.
- **Todas las tablas** InnoDB y `utf8mb4`.
- **Triggers sin SUPER (comprobado):** con `log_bin_trust_function_creators=0` y el usuario de la aplicación, la migración falla con el error 1419 (*You do not have the SUPER privilege and binary logging is enabled*). Por eso el compose de desarrollo lo activa y el VPS requiere migrar con un usuario privilegiado o activar esa variable.

**Diferencias MariaDB/MySQL:** una validación previa en MariaDB 12.3.2 había pasado igual; no apareció ninguna diferencia que corregir. La prueba `mysql-engine` fija el motor para que una base MariaDB o un esquema distinto hagan fallar la suite.

## Hallazgo corregido durante las pruebas

Con una asignación de **toda la clínica** era posible seleccionar un contexto `{clínica propia, sede de otra clínica}`. Corregido en `AccessService.resolve` (la sede debe existir, estar activa y pertenecer a la clínica) y cubierto por una prueba e2e.

## Requisitos antes de habilitar usuarios reales

Este incremento es una base técnica, **no está listo para personal real**. Deben quedar resueltos y probados:

1. Refresh token rotativo y logout con revocación.
2. Recuperación y cambio de contraseña.
3. Regla de "último administrador" (una clínica no puede quedar sin administradores activos).
4. Política de acceso del administrador de clínica a la historia clínica (define los permisos clínicos).
5. Respaldo diario externo con prueba de restauración (documento de arquitectura, 8.6).

## Estructura del monorepo

`apps/api` como único workspace es lo correcto en esta etapa. `apps/admin` (React + Vite, `/admin`) se añadirá cuando se inicie el panel, y `apps/web` y `packages/shared` cuando haya código que los justifique; no se crean frontends ni paquetes vacíos.

## Siguiente incremento sugerido

Módulo de **pacientes y consentimientos**, manteniendo aislamiento por clínica, auditoría de lectura/escritura y adjuntos privados. Antes de empezar conviene resolver:

- política de acceso del administrador de clínica a datos clínicos (define el catálogo de permisos clínicos);
- refresh token y recuperación de contraseña (para dar acceso a personal real);
- validación normativa de consentimientos y conservación (sección 11 del documento de arquitectura).
