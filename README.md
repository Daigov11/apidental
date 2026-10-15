# ApiDental

Software web de gestión odontológica (Perú). Este repositorio contiene la **base técnica** (incremento 1) y la **ficha administrativa del paciente** (incremento 2), sobre las que se construirán historia clínica, agenda, odontograma, pagos e inventario.

- Arquitectura y decisiones de producto: [`docs/arquitectura/mvp-p0-apidental.md`](docs/arquitectura/mvp-p0-apidental.md)
- Incremento 1 (fundación: tenancy, JWT, RBAC, auditoría): [`docs/arquitectura/incremento-1-fundacion.md`](docs/arquitectura/incremento-1-fundacion.md)
- Incremento 2 (pacientes, consentimientos, adjuntos privados): [`docs/arquitectura/incremento-2-pacientes.md`](docs/arquitectura/incremento-2-pacientes.md)

## Qué incluye (y qué no)

Incluye: API NestJS versionada en `/v1`, Prisma + MySQL, clínicas, sedes, usuarios, roles, permisos y asignaciones, autenticación JWT, autorización por clínica/sede/rol, auditoría inmutable, health check, **pacientes** (identificadores DNI/CE/pasaporte, contacto, detección de duplicados sin fusión, representantes de menores), **consentimientos** separados (clínico, fidelización, marketing) y **adjuntos administrativos privados**, con pruebas unitarias y e2e.

**No** incluye (a propósito): antecedentes médicos, diagnósticos, evolución, odontograma, citas, pagos, inventario, firma digital, integración con Apiworking, refresh tokens ni interfaz funcional. Nunca hay eliminación física de pacientes ni adjuntos.

## Estructura

```
apps/api/            API NestJS + Prisma (único workspace por ahora)
  prisma/            schema, migraciones, seed, create-admin, catálogo de roles
  src/               auth, audit, tenancy, users, patients, health, config, prisma, common
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

## Primer administrador

**Desarrollo.** Con `SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD` definidos, `npm run db:seed` crea un usuario con rol `PLATFORM_ADMIN` y `CLINIC_ADMIN` de la Clínica Demo. La contraseña vive solo en su `.env`, nunca en el repositorio. El seed ignora estas variables si `NODE_ENV=production`.

**Producción.**

```bash
NODE_ENV=production npm run db:seed -w apps/api    # solo catálogo de roles/permisos (sin datos demo)
NODE_ENV=production npm run db:create-admin -w apps/api -- --email admin@su-dominio.pe
```

La contraseña se pide por terminal **sin eco** y con confirmación. En producción no se acepta por variable de entorno ni por argumento. Cree después las clínicas y administradores de clínica desde la API. El comando deja una entrada `ADMIN_BOOTSTRAPPED` en la auditoría.

## Uso de la API

Todas las rutas están bajo `/v1`. Errores con formato uniforme: `{ statusCode, error, message, path, requestId, timestamp }`.

Flujo: **login** (token sin contexto) → **listar contextos** → **seleccionar contexto** (token con clínica/sede activa) → usar la API.

| Método y ruta | Permiso | Descripción |
|---|---|---|
| `GET /v1/health` | público | Estado de la API y de la base de datos |
| `POST /v1/auth/login` | público | Correo + contraseña → token de acceso (límite por IP y bloqueo por usuario) |
| `GET /v1/auth/me` | autenticado | Perfil, contexto activo, roles y permisos efectivos |
| `GET /v1/auth/context` | autenticado | Clínicas/sedes/roles disponibles según asignaciones activas |
| `POST /v1/auth/select-context` | autenticado | Valida contra `UserAssignment` y emite token con contexto |
| `GET /v1/clinics` · `POST /v1/clinics` | `clinic:read` · `clinic:manage` | Crear clínicas es solo de plataforma |
| `GET /v1/branches` · `POST /v1/branches` | `branch:read` · `branch:manage` | Sedes de la clínica activa |
| `GET /v1/users` · `POST /v1/users` | `user:read` · `user:manage` | Usuarios dentro del alcance del solicitante |
| `GET /v1/roles` | `role:read` | Roles y permisos (las clínicas no ven roles de plataforma) |
| `POST /v1/assignments` · `PATCH /v1/assignments/:id/revoke` | `assignment:manage` | Asignar y revocar roles |
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

- Contraseñas con **Argon2id**. Bloqueo progresivo por usuario (`LOGIN_MAX_ATTEMPTS`, `LOGIN_LOCK_MINUTES`) y límite de solicitudes por IP, más estricto en el login. Mensaje único `Credenciales inválidas` y tiempos igualados para no revelar si un correo existe.
- JWT HS256 de corta vida (15 min por defecto) con emisor y audiencia verificados. **El token no contiene permisos**: en cada solicitud se leen el usuario y sus asignaciones, por lo que deshabilitar un usuario o revocar una asignación surte efecto de inmediato.
- Sin asignación activa no hay acceso. El `clinicId` sale siempre del contexto validado, nunca de parámetros del cliente.
- Anti-escalada: nadie otorga un rol con más permisos que los propios; una clínica no asigna fuera de la suya ni roles de plataforma.
- `passwordHash` se excluye por defecto de toda consulta Prisma y nunca se serializa.
- La auditoría registra login (éxito, fallo, bloqueo), selección/denegación de contexto y acciones administrativas, con IP y user agent, sin contraseñas ni tokens. `audit_logs` es **inmutable por triggers** en la base de datos.
- Logging estructurado (JSON en producción) sin cuerpos, cabeceras ni tokens. Helmet, CORS restringido y cuerpo JSON máximo de 100 kb.
- **Datos de pacientes:** siempre dentro de la clínica del contexto (un paciente ajeno responde 404), FK compuestas en la base de datos, vistas por permiso (el cajero solo ve identificación y contacto), **lecturas auditadas** y auditoría sin datos personales (valores enmascarados). Sin eliminación física: triggers lo impiden.
- **Adjuntos:** disco privado con nombre UUID, tipo detectado por contenido (PDF/JPEG/PNG/WebP), tamaño máximo, SHA-256 verificado en cada descarga, descarga solo por API autorizada y auditada, sin rutas ni claves en las respuestas, baja lógica con motivo.

## Producción (Debian + systemd + Nginx)

Plantillas en `deploy/`. **Nada se despliega ni se ejecuta desde este repositorio.**

- La API usa `deploy/systemd/apidental-api.service.example` y variables en `/etc/apidental/api.env` (permisos 600). Defina `NODE_ENV=production`, `TRUST_PROXY=1`, `CORS_ORIGINS=https://dental.apiworking.com.pe` y un `JWT_ACCESS_SECRET` propio. La API se niega a iniciar con el secreto de ejemplo o con configuración inválida.
- **Triggers y binlog:** la migración crea triggers (auditoría inmutable). Con el binlog activo (por defecto en MySQL 8), MySQL exige `SUPER` o `log_bin_trust_function_creators=1` para crearlos. Ejecute las migraciones con un usuario con privilegios (o active esa variable) y use **otro usuario** para la aplicación.
- **Usuario de la aplicación:** `SELECT, INSERT, UPDATE, DELETE` sobre las tablas, pero **solo `SELECT, INSERT` sobre `audit_logs`** como segunda barrera además de los triggers.
- **Adjuntos:** defina `ATTACHMENTS_DIR` con una ruta **absoluta** (p. ej. `/var/lib/apidental/files`), propietario `apidental`, modo `0700`, fuera de cualquier `root`/`alias` de Nginx, y agregue `ReadWritePaths=` en la unidad systemd. Ese directorio **debe incluirse en los respaldos** junto con MySQL; un respaldo solo de la base deja registros sin archivos. Se recomienda cifrar el volumen. La API se niega a iniciar en producción si la ruta es relativa.
- Los respaldos diarios externos con prueba de restauración son requisito previo a operar con datos de pacientes (ver documento de arquitectura, sección 8.6).

## Solución de problemas

- `Docker Desktop is manually paused`: reanúdelo desde el menú de la ballena.
- Puerto ocupado: cambie `MYSQL_HOST_PORT` (y las URLs) en `.env`.
- `npm install` falla con `Cannot read properties of null (reading 'edgesOut')`: es un defecto de npm 10 con `vitest@4.1.x`; el proyecto usa `vitest@5`. Actualice npm si aparece con otras versiones.
- Prisma 7 no carga `.env` por sí mismo: `prisma.config.ts` lo hace; ejecute los comandos desde `apps/api` o con `-w apps/api`.
