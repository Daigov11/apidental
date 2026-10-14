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

1. **Sin refresh token ni logout.** Lo permitía el alcance y la estrategia final de cookies entre `dental.apiworking.com.pe` y `api.dental...` sigue sin confirmar. El access token vive 15 min; el cierre de sesión es descartar el token en el cliente. La revocación inmediata se logra deshabilitando al usuario o revocando asignaciones (se comprueban en cada solicitud). **Pendiente:** definir refresh rotativo (documento de arquitectura, 8.1).
2. **Sin recuperación ni cambio de contraseña.** El administrador fija la contraseña inicial al crear un usuario. Es una limitación temporal que debe resolverse antes de dar acceso a personal real.
3. **Sin Swagger/OpenAPI.** Se difiere; la tabla de endpoints está en el README.
4. **RBAC inicial fijo.** Permisos por rol definidos en código y sincronizados por el seed; no editables por clínica. No existe ningún permiso clínico: ni siquiera el administrador de plataforma puede leer datos clínicos futuros, y esa política **debe decidirse explícitamente** cuando haya módulos clínicos (documento de arquitectura, sección 11, puntos 5 y 11).
5. **`POST /v1/assignments` acepta cualquier `userId`.** Un administrador de clínica puede asignar a su clínica a un usuario existente de otra; la respuesta 404 vs 201 revela si un id existe. Con UUIDs no adivinables el riesgo es bajo; se revisará al introducir invitaciones.
6. **Un administrador no puede revocar sus propias asignaciones** (evita el auto-bloqueo), pero otro administrador sí podría dejar a la clínica sin administradores. Regla de "último administrador" pendiente.
7. **RUC:** solo se valida el formato de 11 dígitos; no se valida contra SUNAT (por validar).
8. **Zona horaria:** las fechas se guardan en UTC; la conversión a `America/Lima` es responsabilidad de la presentación.
9. **IP del cliente:** `req.ip` solo es fiable con `TRUST_PROXY=1` detrás de Nginx; sin él, el límite de tasa y la auditoría verán la IP del proxy.

## Verificación realizada y sus límites

Ejecutado el 2026-10-14 en el entorno de desarrollo:

| Comprobación | Resultado |
|---|---|
| `tsc --noEmit`, `oxlint --type-aware`, `nest build` | Sin errores |
| Pruebas unitarias | 31 de 31 |
| Pruebas e2e | 67 de 67 |
| Migración inicial aplicada desde cero y sin desvío (`migrate diff`) | Correcta |
| Seed idempotente; seed en producción sin datos demo ni admin | Correcto |
| API compilada arrancando con `.env`; health y login reales | Correcto |
| Arranque con entorno inválido | Aborta con mensaje claro |
| `npm audit` | 0 vulnerabilidades (con overrides de `mariadb`, `mysql2`, `deepmerge-ts`) |

**Límite importante:** Docker Desktop estaba pausado durante el desarrollo, así que **la base usada para validar fue una instancia temporal de MariaDB 12.3.2, no el MySQL 8.4 objetivo**. El modelo, el CHECK, la FK compuesta y los triggers funcionaron allí, pero **debe repetirse la ejecución contra MySQL 8.4** (`npm run db:up`, migrar, `npm run test:e2e`) antes de darla por validada. Diferencias conocidas a vigilar: tipo `JSON` (en MariaDB es alias de texto), semántica de CHECK y `log_bin_trust_function_creators`.

## Hallazgo corregido durante las pruebas

Con una asignación de **toda la clínica** era posible seleccionar un contexto `{clínica propia, sede de otra clínica}`. Corregido en `AccessService.resolve` (la sede debe existir, estar activa y pertenecer a la clínica) y cubierto por una prueba e2e.

## Siguiente incremento sugerido

Módulo de **pacientes y consentimientos**, manteniendo aislamiento por clínica, auditoría de lectura/escritura y adjuntos privados. Antes de empezar conviene resolver:

- política de acceso del administrador de clínica a datos clínicos (define el catálogo de permisos clínicos);
- refresh token y recuperación de contraseña (para dar acceso a personal real);
- validación normativa de consentimientos y conservación (sección 11 del documento de arquitectura).
