# ApiDental

Software web de gestión odontológica (Perú). Este repositorio contiene la **base técnica** (incremento 1) y la **ficha administrativa del paciente** (incremento 2), sobre las que se construirán historia clínica, agenda, odontograma, pagos e inventario.

- Arquitectura y decisiones de producto: [`docs/arquitectura/mvp-p0-apidental.md`](docs/arquitectura/mvp-p0-apidental.md)
- Incremento 1 (fundación: tenancy, JWT, RBAC, auditoría): [`docs/arquitectura/incremento-1-fundacion.md`](docs/arquitectura/incremento-1-fundacion.md)
- Incremento 2 (pacientes, consentimientos, adjuntos privados): [`docs/arquitectura/incremento-2-pacientes.md`](docs/arquitectura/incremento-2-pacientes.md)
- **Política de acceso clínico P0** (adoptada): [`docs/arquitectura/politica-acceso-clinico.md`](docs/arquitectura/politica-acceso-clinico.md)
- **Sub-incremento 3.0** (acceso seguro: invitaciones, sesiones, reautenticación, último administrador): [`docs/arquitectura/incremento-3-0-acceso-seguro.md`](docs/arquitectura/incremento-3-0-acceso-seguro.md)
- **Sub-incremento 3.1** (relación asistencial y control de acceso clínico): [`docs/arquitectura/incremento-3-1-acceso-clinico.md`](docs/arquitectura/incremento-3-1-acceso-clinico.md)
- **Sub-incremento 3.2** (antecedentes, alergias y alertas clínicas): [`docs/arquitectura/incremento-3-2-antecedentes-alertas.md`](docs/arquitectura/incremento-3-2-antecedentes-alertas.md) · **parche 3.2.1** (evaluación de alergias, motivo del alta): [`incremento-3-2-1-parche.md`](docs/arquitectura/incremento-3-2-1-parche.md)
- Incremento 3 (**propuesta**, historia clínica; sin código): [`docs/arquitectura/incremento-3-historia-clinica.md`](docs/arquitectura/incremento-3-historia-clinica.md)
- Sistema de diseño (propuesta, previo al frontend): [`docs/diseno/sistema-de-diseno.md`](docs/diseno/sistema-de-diseno.md) · vista previa: [`docs/diseno/vista-previa.html`](docs/diseno/vista-previa.html)

## Qué incluye (y qué no)

Incluye: API NestJS versionada en `/v1`, Prisma + MySQL, clínicas, sedes, usuarios, roles, permisos y asignaciones, autenticación JWT con **refresh token rotativo y logout**, **reautenticación**, **alta de usuarios solo por invitación**, aprovisionamiento formal del Director Clínico, regla de último administrador, autorización por clínica/sede/rol, auditoría inmutable, health check, **pacientes** (identificadores DNI/CE/pasaporte, contacto, detección de duplicados sin fusión, representantes de menores), **consentimientos** separados (clínico, fidelización, marketing) y **adjuntos administrativos privados**, con pruebas unitarias y e2e.

Desde 3.1 incluye también el **control de acceso clínico**: relación asistencial paciente–odontólogo, permisos `clinical:*`, vista de apoyo del asistente y lectura excepcional del Director (`clinical:read_all`) con justificación, reautenticación y auditoría previa.

Desde 3.2 incluye **antecedentes, alergias y alertas clínicas** versionados (corrección, rectificación, desactivación, historial y motivo; sin eliminación física), siempre bajo el motor de acceso de 3.1.

**No** incluye (a propósito): diagnósticos, procedimientos, visitas, evolución, odontograma, citas, pagos, inventario, firma digital, integración con Apiworking ni interfaz funcional. Nunca hay eliminación física de pacientes ni adjuntos.

## Estructura

```
apps/api/            API NestJS + Prisma (único workspace por ahora)
  prisma/            schema, migraciones, seed, create-admin, catálogo de roles
  src/               auth, audit, tenancy, users, invitations, provisioning, patients, health, config, prisma, common
  test/              pruebas e2e (contra una base *_test real)
deploy/              PLANTILLAS para el VPS (nginx, systemd, deploy.sh). No se ejecutan desde aquí.
docker/, docker-compose.dev.yml   MySQL 8.4 SOLO para desarrollo local
docs/arquitectura/   documentación de arquitectura
```

Reservados y **no creados** todavía (no aportan valor funcional en este incremento): `apps/admin` (React + Vite, servido en `/admin`), `apps/web` (Next.js) y `packages/shared`. Se agregarán al workspace cuando exista código que los justifique.

## Requisitos

- Node.js 22 o superior (`.nvmrc`) y npm 10+.
- Docker (solo para levantar MySQL local) **o** un MySQL 8 propio.
- Git.

## Puesta en marcha desde cero

```bash
# 1. Dependencias
npm install

# 2. Configuración (el .env NO se versiona)
cp .env.example .env
#    Edite .env: genere un secreto JWT propio y, si quiere un usuario de desarrollo,
#    defina SEED_ADMIN_EMAIL y SEED_ADMIN_PASSWORD (>= 12 caracteres).
openssl rand -base64 48        # valor sugerido para JWT_ACCESS_SECRET

# 3. Base de datos MySQL 8.4 en Docker (puerto 3310 del host por defecto)
npm run db:up
#    Si su puerto 3310 está ocupado, cambie MYSQL_HOST_PORT y las URLs en .env.

# 4. Cliente Prisma, migración inicial y datos de desarrollo
npm run prisma:generate -w apps/api
npm run db:migrate                    # aplica prisma/migrations
npm run db:seed                       # roles, permisos, Clínica Demo, Sede Demo, admin de desarrollo y pacientes FICTICIOS

# 5. Ejecutar la API
npm run api:dev                       # http://127.0.0.1:3000/v1/health
```

> Con un MySQL propio en lugar de Docker: cree las bases `apidental_dev`, `apidental_test` y `apidental_shadow`, un usuario con todos los privilegios sobre `apidental_%` y ajuste las URLs en `.env`. Ver "Producción" por el requisito de triggers.

### Calidad y build

```bash
npm run typecheck      # tsc --noEmit
npm run lint           # oxlint (con tipos)
npm test               # pruebas unitarias
npm run test:e2e       # pruebas e2e: aplican migraciones a TEST_DATABASE_URL y la VACÍAN
npm run build          # prisma generate + nest build (apps/api/dist)
```

Las pruebas e2e **se niegan a ejecutarse** si `TEST_DATABASE_URL` no termina en `_test`. Usan un directorio temporal para adjuntos (nunca el de desarrollo) y una prueba (`mysql-engine`) falla si el motor no es MySQL 8.4.

## Primer administrador y alta de usuarios

**No existe forma de crear usuarios con una contraseña fijada por un administrador**: cada persona define la suya al aceptar una invitación.

**Primer administrador de plataforma.**

*Desarrollo.* Con `SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD` definidos, `npm run db:seed` crea un usuario con `PLATFORM_ADMIN` y `CLINIC_ADMIN` de la Clínica Demo. La contraseña vive solo en su `.env`. El seed ignora estas variables en producción.

*Producción.*

```bash
NODE_ENV=production npm run db:seed -w apps/api    # solo catálogo de roles/permisos (sin datos demo)
NODE_ENV=production npm run db:create-admin -w apps/api -- --email admin@su-dominio.pe
```

La contraseña se pide por terminal **sin eco** y con confirmación; en producción no se acepta por variable ni argumento. El comando deja `ADMIN_BOOTSTRAPPED` en la auditoría.

**Resto de usuarios: invitaciones** (documento completo en [`incremento-3-0-acceso-seguro.md`](docs/arquitectura/incremento-3-0-acceso-seguro.md)):

1. La **plataforma** crea la clínica (`POST /v1/clinics`) e **invita al primer administrador** (`POST /v1/invitations`, solo mientras la clínica no tenga administrador).
2. Ese administrador **invita al personal** de su clínica. La persona abre el enlace y crea su contraseña (`POST /v1/invitations/accept`).
3. Para el **primer Director Clínico**: el administrador registra el aprovisionamiento formal (`POST /v1/provisioning-records`, con reautenticación) y luego invita al designado. Los siguientes los designa un Director vigente.

**Recuperación de contraseña** (pública, sin sesión):

1. `POST /v1/auth/password-recovery` `{ "email" }` → **siempre `202` con el mismo cuerpo y tiempo**, exista o no la cuenta (o esté deshabilitada). Si procede, se entrega por el canal configurado un enlace de un solo uso (`PASSWORD_RECOVERY_BASE_URL#token=…`, 30 min). Una sola recuperación pendiente por cuenta; espera mínima y tope diario silenciosos.
2. `POST /v1/auth/password-recovery/validate` `{ "token" }` → comprueba el enlace sin consumirlo (`404` uniforme si no sirve).
3. `POST /v1/auth/password-recovery/confirm` `{ "token", "newPassword" }` → fija la nueva clave (política: 12–128 caracteres, variedad mínima, distinta de la actual y del correo). **Revoca todas las sesiones**, invalida las pruebas de reautenticación y las invitaciones pendientes al correo, y **no inicia sesión**: la persona entra con su nueva clave.

Las tres rutas comparten el límite estricto por IP del login. Pantalla del panel: `/admin/restablecer-contrasena`. Esta recuperación depende por completo del canal de entrega (ver Producción).

**Deshabilitar y reactivar usuarios** (`user:manage`, motivo obligatorio): `POST /v1/users/:id/disable` · `POST /v1/users/:id/reactivate`. Nunca se elimina al usuario; deshabilitar es inmediato (revoca sesiones, refresh tokens, pruebas de reautenticación y recuperaciones). Una clínica solo gestiona usuarios que trabajan únicamente en ella (si la cuenta es compartida, `409 ACCOUNT_SHARED`: revoque su asignación); no se puede deshabilitar a uno mismo ni al **último administrador / Director**; lo que deshabilita la plataforma solo la plataforma lo reactiva. Reactivar no restaura sesiones.

El enlace de invitación **solo se devuelve en desarrollo/pruebas** (`INVITATION_DELIVERY_MODE=dev`). En producción hay que configurar un canal (`webhook` firmado hacia su sistema de envío); sin canal, crear invitaciones responde `503`.

## Uso de la API

Todas las rutas están bajo `/v1`. Errores con formato uniforme: `{ statusCode, error, message, path, requestId, timestamp }`.

Flujo: **login** (access token sin contexto + cookie del refresh token) → **listar contextos** → **seleccionar contexto** (token con clínica/sede activa) → usar la API → **refresh** cuando venza (15 min) → **logout**.

| Método y ruta | Permiso | Descripción |
|---|---|---|
| `GET /v1/health` | público | Estado de la API y de la base de datos |
| `POST /v1/auth/login` | público | Correo + contraseña → access token (15 min, en memoria) y **cookie HttpOnly con el refresh token** (límite por IP y bloqueo por usuario) |
| `POST /v1/auth/refresh` | cookie + CSRF | Rota el refresh token y entrega un access token nuevo (restaura el contexto) |
| `POST /v1/auth/logout` · `POST /v1/auth/logout-all` | cookie/Bearer + CSRF | Cierra la sesión actual / todas las del usuario; el access token deja de valer al instante |
| `POST /v1/auth/reauthenticate` | autenticado | Confirma la contraseña y emite una **prueba de 2 min, un solo uso**, por propósito y objeto. **No es una firma** digital, legal ni clínica |
| `GET /v1/auth/me` | autenticado | Perfil, contexto activo, roles y permisos efectivos |
| `GET /v1/auth/context` | autenticado | Clínicas/sedes/roles disponibles según asignaciones activas |
| `POST /v1/auth/select-context` | autenticado | Valida contra `UserAssignment` y emite token con contexto |
| `GET /v1/clinics` · `POST /v1/clinics` | `clinic:read` · `clinic:manage` | Crear clínicas es solo de plataforma |
| `GET /v1/branches` · `POST /v1/branches` | `branch:read` · `branch:manage` | Sedes de la clínica activa |
| `GET /v1/users` | `user:read` | Usuarios dentro del alcance del solicitante (el alta es solo por invitación) |
| `GET /v1/roles` | `role:read` | Roles y permisos (las clínicas no ven roles de plataforma) |
| `POST /v1/assignments` · `PATCH /v1/assignments/:id/revoke` | `assignment:manage` | Asignar roles a usuarios **existentes** y revocarlos. La plataforma no otorga roles de clínica; el Director Clínico solo se otorga por invitación; **nunca se quita al último administrador/Director** (409) |
| `POST /v1/invitations` · `GET` · `POST /:id/revoke` · `POST /:id/resend` | `invitation:manage` / `director:manage` · `invitation:read` | Invitaciones de un solo uso (el token solo viaja por el canal de entrega) |
| `POST /v1/invitations/preview` · `POST /v1/invitations/accept` | **público** (límite estricto por IP) | La persona crea su propia contraseña (o usa la actual si ya tiene cuenta) |
| `POST /v1/provisioning-records` · `GET` · `POST /:id/revoke` | `provisioning:record` / `provisioning:read` | Registro formal de la autorización de la clínica para su primer Director Clínico (declarativo; ver limitaciones) |
| `POST /v1/users/:id/disable` · `/reactivate` | `user:manage` (o `director:manage` si el destino es Director) | Nunca elimina; el Director solo lo deshabilita otro Director |
| `GET /v1/audit-logs` | `audit:read` | Auditoría de la clínica activa (plataforma: todas); filtros `action`, `userId`, `patientId` |

**Pacientes** (requieren contexto de clínica; el administrador de plataforma no tiene acceso). Detalle y reglas en [`incremento-2-pacientes.md`](docs/arquitectura/incremento-2-pacientes.md).

| Método y ruta | Permiso | Descripción |
|---|---|---|
| `POST /v1/patients` | `patient:write` | Alta. 409 si el DNI/CE/pasaporte ya existe en la clínica; advertencias de posible duplicado en la respuesta |
| `GET /v1/patients` | `patient:read_basic` | Búsqueda por `identifier`, `name`, `phone`, `email`, `birthDate`, `status` |
| `GET /v1/patients/:id` · `PATCH /v1/patients/:id` | `patient:read_basic` · `patient:write` | Ficha (completa o mínima según permiso) y edición |
| `POST /v1/patients/:id/deactivate` · `/reactivate` | `patient:write` | Baja/alta lógica con motivo |
| `POST /v1/patients/duplicate-check` · `GET /v1/patients/duplicate-report` · `GET /v1/patients/:id/duplicates` | `patient:write` · `patient:read` | Posibles duplicados (nunca se fusionan) |
| `PUT /v1/patients/:id/identifiers` | `patient:write` | Alta/reemplazo de documento (motivo si se reemplaza) |
| `POST /v1/patients/:id/contacts` · `PATCH …/:contactId` · `POST …/:contactId/retire` | `patient:write` | Contactos con historial (motivo en celular/correo) |
| `GET/POST /v1/patients/:id/guardians` · `POST …/:linkId/end` · `GET /v1/guardians?search=` | `patient:read` / `patient:write` | Representantes de menores |
| `GET/POST /v1/patients/:id/consents` · `POST …/:consentId/revoke` | `consent:read` / `consent:write` | Consentimientos (revocar exige motivo) |
| `POST /v1/patients/:id/attachments` (multipart) · `POST …/:attachmentId/remove` | `attachment:write` | Carga y baja lógica de adjuntos |
| `GET /v1/patients/:id/attachments` · `GET …/:attachmentId/download` | `attachment:read` | Listado y descarga autorizada (sin URL pública) |

**Acceso clínico (3.1).** Ningún permiso `clinical:*` da acceso por sí solo; hace falta además una **relación asistencial** (odontólogo, asistente) o una **autorización justificada** (Director). Detalle en [`incremento-3-1-acceso-clinico.md`](docs/arquitectura/incremento-3-1-acceso-clinico.md).

| Método y ruta | Permiso | Descripción |
|---|---|---|
| `POST /v1/patients/:id/care-relationships` · `GET` | `care:assign` | Asigna/lista la relación paciente–odontólogo (acto administrativo; nadie se asigna a sí mismo ni a quien él otorgó) |
| `POST /v1/care-relationships/:relId/revoke` · `GET /v1/care-relationships` | `care:assign` | Revoca con motivo / revisión de la clínica |
| `GET /v1/patients/:id/clinical-summary` | `clinical:read` · `read_limited` · `read_all` | Resumen clínico (hoy: acceso, alertas y datos de apoyo). Auditado **antes** de entregar; `404` igual para ajeno e inexistente |
| `POST /v1/patients/:id/clinical-access` | `clinical:read_all` (Director) | Categoría + motivo ≥ 10 caracteres + reautenticación `CLINICAL_READ_ALL` del paciente → lectura de **ese** paciente por 30 min, solo lectura |

**Antecedentes, alergias y alertas (3.2).** Texto estructurado de apoyo administrativo; el alta no exige motivo (sí la fuente); todo cambio posterior exige motivo y `expectedVersion`. Detalle en [`incremento-3-2-antecedentes-alertas.md`](docs/arquitectura/incremento-3-2-antecedentes-alertas.md).

| Método y ruta | Quién | Descripción |
|---|---|---|
| `GET/POST /v1/patients/:id/clinical/history` | Odontólogo con relación · Director con autorización (solo lectura) | Antecedentes y alergias vigentes / alta |
| `GET …/history/:itemId` · `…/versions` | ídem | Detalle e historial completo de versiones |
| `POST …/history/:itemId/correct` · `rectify` · `deactivate` · `reactivate` · `mark-error` | Odontólogo con relación | Nueva versión con motivo; `409` si la versión cambió |
| `GET /v1/patients/:id/clinical/alerts` | Odontólogo, Director (autorizado) y **asistente (vista mínima)** | Alertas activas: derivadas de lo crítico + manuales. Informativas, no bloquean nada |
| `POST /v1/patients/:id/clinical/alerts` · `…/:itemId/correct` · `deactivate` · `reactivate` · `mark-error` · `GET …/versions` | Odontólogo con relación | Alertas manuales con severidad, vigencia y motivo |
| `GET/PUT /v1/patients/:id/clinical/allergy-assessment` · `GET …/versions` | Odontólogo con relación (PUT) · Director autorizado (solo lectura) · **no** el asistente | Evaluación de alergias: `NOT_ASKED` / `NO_KNOWN_ALLERGIES` / `ALLERGIES_RECORDED` (este último lo deriva el sistema; no coexiste con `NO_KNOWN_ALLERGIES`) |
| `GET /v1/clinical/options` | Cualquier perfil clínico | Valores sugeridos (no limitan lo que se registra) |

Ejemplo de carga y descarga:

```bash
curl -s -X POST "localhost:3000/v1/patients/$PID/attachments" -H "Authorization: Bearer $CTX" \
  -F category=CONSENT -F "file=@consentimiento.pdf;type=application/pdf"
curl -s -o copia.pdf "localhost:3000/v1/patients/$PID/attachments/$AID/download" -H "Authorization: Bearer $CTX"
```

Ejemplo:

```bash
TOKEN=$(curl -s localhost:3000/v1/auth/login -H 'content-type: application/json' \
  -d '{"email":"admin.dev@apidental.test","password":"<su clave>"}' | jq -r .accessToken)
curl -s localhost:3000/v1/auth/context -H "Authorization: Bearer $TOKEN"
CTX=$(curl -s localhost:3000/v1/auth/select-context -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"clinicId":"<id de la clínica>"}' | jq -r .accessToken)
curl -s localhost:3000/v1/branches -H "Authorization: Bearer $CTX"
```

## Modelo de seguridad (resumen)

- Contraseñas con **Argon2id**. Bloqueo progresivo por usuario (`LOGIN_MAX_ATTEMPTS`, `LOGIN_LOCK_MINUTES`) y límite de solicitudes por IP, más estricto en el login, la reautenticación y las invitaciones públicas. Mensaje único `Credenciales inválidas` y tiempos igualados para no revelar si un correo existe.
- **Sesiones:** el refresh token (256 bits) rota en cada uso, se guarda solo su **SHA-256**, y su **reutilización revoca la sesión completa**. Va en una cookie `__Host-` **HttpOnly, Secure, SameSite=Strict, host-only** (sin `Domain`). El access token solo se guarda en memoria y deja de valer al instante al cerrar la sesión.
- **CSRF** (refresh/logout): `SameSite=Strict` + `Origin` permitido + cabecera `X-Requested-With: ApiDental` + `Content-Type: application/json` + `Sec-Fetch-Site`. El resto de la API usa `Authorization: Bearer` y no es vulnerable. CORS con credenciales **solo** para el origen configurado.
- **Recuperación de contraseña:** respuesta neutral e idéntica en contenido y tiempo, token de 256 bits de un solo uso y solo su hash guardado, revoca todas las sesiones y no inicia sesión. **Deshabilitar** es inmediato y nunca borra.
- **Invitaciones:** token de un solo uso con expiración; la persona define su clave; una invitación nunca cambia la clave de una cuenta existente; ninguna respuesta revela si un correo tiene cuenta.
- JWT HS256 de corta vida (15 min por defecto) con emisor y audiencia verificados. **El token no contiene permisos**: en cada solicitud se leen la sesión, el usuario y sus asignaciones, por lo que cerrar la sesión, deshabilitar un usuario o revocar una asignación surte efecto de inmediato.
- Sin asignación activa no hay acceso. El `clinicId` sale siempre del contexto validado, nunca de parámetros del cliente.
- Anti-escalada: nadie otorga un rol con más permisos que los propios; una clínica no asigna fuera de la suya ni roles de plataforma. La plataforma solo invita al primer administrador y **nunca** designa al Director Clínico. Una clínica no puede quedar sin administrador ni sin Director (una vez designado).
- `passwordHash` se excluye por defecto de toda consulta Prisma y nunca se serializa.
- La auditoría registra login (éxito, fallo, bloqueo), selección/denegación de contexto y acciones administrativas, con IP y user agent, sin contraseñas ni tokens. `audit_logs` es **inmutable por triggers** en la base de datos.
- Logging estructurado (JSON en producción) sin cuerpos, cabeceras ni tokens. Helmet, CORS restringido y cuerpo JSON máximo de 100 kb.
- **Datos de pacientes:** siempre dentro de la clínica del contexto (un paciente ajeno responde 404), FK compuestas en la base de datos, vistas por permiso (el cajero solo ve identificación y contacto), **lecturas auditadas** y auditoría sin datos personales (valores enmascarados). Sin eliminación física: triggers lo impiden.
- **Adjuntos:** disco privado con nombre UUID, tipo detectado por contenido (PDF/JPEG/PNG/WebP), tamaño máximo, SHA-256 verificado en cada descarga, descarga solo por API autorizada y auditada, sin rutas ni claves en las respuestas, baja lógica con motivo.

## Producción (Debian + systemd + Nginx)

Plantillas en `deploy/`. **Nada se despliega ni se ejecuta desde este repositorio.**

- **Sesiones y cookie:** el panel (`dental.apiworking.com.pe`) llama a la API (`api.dental.apiworking.com.pe`) con `credentials: 'include'`. Defina `CORS_ORIGINS=https://dental.apiworking.com.pe` (el origen **exacto**; nunca `*`). La cookie del refresh token es `__Host-apidental_rt` (HttpOnly, Secure, SameSite=Strict, sin `Domain`): requiere HTTPS en ambos hosts y que Nginx **no** elimine ni reescriba `Set-Cookie`/`Origin`. `TRUST_PROXY=1` para que la IP de cada sesión sea la real. La API se niega a iniciar con `COOKIE_SECURE=false` en producción.
- **Invitaciones:** en producción `INVITATION_DELIVERY_MODE` debe ser `webhook` (con `INVITATION_WEBHOOK_URL` https, `INVITATION_WEBHOOK_SECRET` de 32+ caracteres e `INVITATION_ACCEPT_BASE_URL` https). Su sistema receptor debe **verificar la firma HMAC** (`X-ApiDental-Signature`) y rechazar marcas de tiempo antiguas. Con `dev` la API no inicia; con `disabled` (por defecto) no se pueden crear invitaciones.
- **Recuperación de contraseña:** reutiliza el canal de `INVITATION_DELIVERY_MODE` (evento `password_recovery.deliver` en el webhook firmado). Defina `PASSWORD_RECOVERY_BASE_URL` (https). Con el canal `disabled` las solicitudes siguen respondiendo `202` pero no se entrega nada: **sin canal no hay recuperación**.
- **Mantenimiento de seguridad (depuración):** `npm run build` y luego `npm run maintenance:dry-run` (solo cuenta) / `npm run maintenance` (aplica). Vence invitaciones, recuperaciones, registros de aprovisionamiento y sesiones caducadas, y **depura por lotes** sesiones revocadas, pruebas de reautenticación, invitaciones y recuperaciones **cerradas** que superaron su retención (`RETENTION_*`). Conserva siempre la auditoría, los usuarios, las asignaciones, el registro de aprovisionamiento y todo lo pendiente o reciente (la base de datos impide además borrar invitaciones/recuperaciones pendientes o con menos de 30 días). Imprime un resumen JSON y falla con código ≠ 0 si hay error; deja `MAINTENANCE_PURGE` en la auditoría solo con contadores. Es idempotente; planifíquelo **una vez al día** con `deploy/systemd/apidental-maintenance.{service,timer}.example` (oneshot: no se solapa consigo mismo).
- **Accesos denegados:** los `403` de usuarios autenticados se auditan como `ACCESS_DENIED` (método, patrón de ruta, motivo y permisos exigidos; sin ids, consulta ni cuerpo; deduplicados 60 s), y los rechazos de reautenticación como `REAUTH_REJECTED` (con la razón, sin el token). Revíselos periódicamente: ráfagas de ambos, o de `REFRESH_REUSE_DETECTED`, son señales de abuso.
- La API usa `deploy/systemd/apidental-api.service.example` y variables en `/etc/apidental/api.env` (permisos 600). Defina `NODE_ENV=production`, `TRUST_PROXY=1`, `CORS_ORIGINS=https://dental.apiworking.com.pe` y un `JWT_ACCESS_SECRET` propio. La API se niega a iniciar con el secreto de ejemplo o con configuración inválida.
- **Triggers y binlog:** la migración crea triggers (auditoría inmutable). Con el binlog activo (por defecto en MySQL 8), MySQL exige `SUPER` o `log_bin_trust_function_creators=1` para crearlos. Ejecute las migraciones con un usuario con privilegios (o active esa variable) y use **otro usuario** para la aplicación.
- **Usuario de la aplicación:** `SELECT, INSERT, UPDATE, DELETE` sobre las tablas, pero **solo `SELECT, INSERT` sobre `audit_logs`** como segunda barrera además de los triggers.
- **Adjuntos:** defina `ATTACHMENTS_DIR` con una ruta **absoluta** (p. ej. `/var/lib/apidental/files`), propietario `apidental`, modo `0700`, fuera de cualquier `root`/`alias` de Nginx, y agregue `ReadWritePaths=` en la unidad systemd. Ese directorio **debe incluirse en los respaldos** junto con MySQL; un respaldo solo de la base deja registros sin archivos. Se recomienda cifrar el volumen. La API se niega a iniciar en producción si la ruta es relativa.
- **Condiciones obligatorias antes de cargar pacientes reales:** (1) canal de entrega de invitaciones y recuperación **probado** de extremo a extremo; (2) **respaldo diario externo con restauración verificada** (base de datos y adjuntos); (3) **revisión legal**. Además: mantenimiento programado y **notificación de “contraseña cambiada”** (pendiente).

## Solución de problemas

- `Docker Desktop is manually paused`: reanúdelo desde el menú de la ballena.
- Puerto ocupado: cambie `MYSQL_HOST_PORT` (y las URLs) en `.env`.
- `npm install` falla con `Cannot read properties of null (reading 'edgesOut')`: es un defecto de npm 10 con `vitest@4.1.x`; el proyecto usa `vitest@5`. Actualice npm si aparece con otras versiones.
- Prisma 7 no carga `.env` por sí mismo: `prisma.config.ts` lo hace; ejecute los comandos desde `apps/api` o con `-w apps/api`.
