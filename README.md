# ApiDental

Software web de gestión odontológica (Perú). Este repositorio contiene el **primer incremento técnico**: la base segura y extensible sobre la que se construirán pacientes, historia clínica, agenda, odontograma, pagos e inventario.

- Arquitectura y decisiones de producto: [`docs/arquitectura/mvp-p0-apidental.md`](docs/arquitectura/mvp-p0-apidental.md)
- Decisiones, supuestos y límites de este incremento: [`docs/arquitectura/incremento-1-fundacion.md`](docs/arquitectura/incremento-1-fundacion.md)

## Qué incluye (y qué no)

Incluye: API NestJS versionada en `/v1`, Prisma + MySQL con migración inicial, clínicas, sedes, usuarios, roles, permisos y asignaciones, autenticación JWT, autorización por clínica/sede/rol, auditoría inmutable, health check, pruebas unitarias y e2e.

**No** incluye (a propósito): pacientes, historias clínicas, agenda, odontograma, pagos, inventario, integración con Apiworking, refresh tokens ni interfaz funcional.

## Estructura

```
apps/api/            API NestJS + Prisma (único workspace por ahora)
  prisma/            schema, migraciones, seed, create-admin, catálogo de roles
  src/               auth, audit, tenancy, users, health, config, prisma, common
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
npm run db:seed                       # roles, permisos, Clínica Demo, Sede Demo y admin de desarrollo

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

Las pruebas e2e **se niegan a ejecutarse** si `TEST_DATABASE_URL` no termina en `_test`.

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
| `GET /v1/audit-logs` | `audit:read` | Auditoría de la clínica activa (plataforma: todas) |

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
- Logging estructurado (JSON en producción) sin cuerpos, cabeceras ni tokens. Helmet, CORS restringido y cuerpo máximo de 100 kb.

## Producción (Debian + systemd + Nginx)

Plantillas en `deploy/`. **Nada se despliega ni se ejecuta desde este repositorio.**

- La API usa `deploy/systemd/apidental-api.service.example` y variables en `/etc/apidental/api.env` (permisos 600). Defina `NODE_ENV=production`, `TRUST_PROXY=1`, `CORS_ORIGINS=https://dental.apiworking.com.pe` y un `JWT_ACCESS_SECRET` propio. La API se niega a iniciar con el secreto de ejemplo o con configuración inválida.
- **Triggers y binlog:** la migración crea triggers (auditoría inmutable). Con el binlog activo (por defecto en MySQL 8), MySQL exige `SUPER` o `log_bin_trust_function_creators=1` para crearlos. Ejecute las migraciones con un usuario con privilegios (o active esa variable) y use **otro usuario** para la aplicación.
- **Usuario de la aplicación:** `SELECT, INSERT, UPDATE, DELETE` sobre las tablas, pero **solo `SELECT, INSERT` sobre `audit_logs`** como segunda barrera además de los triggers.
- Los respaldos diarios externos con prueba de restauración son requisito previo a operar con datos clínicos (ver documento de arquitectura, sección 8.6).

## Solución de problemas

- `Docker Desktop is manually paused`: reanúdelo desde el menú de la ballena.
- Puerto ocupado: cambie `MYSQL_HOST_PORT` (y las URLs) en `.env`.
- `npm install` falla con `Cannot read properties of null (reading 'edgesOut')`: es un defecto de npm 10 con `vitest@4.1.x`; el proyecto usa `vitest@5`. Actualice npm si aparece con otras versiones.
- Prisma 7 no carga `.env` por sí mismo: `prisma.config.ts` lo hace; ejecute los comandos desde `apps/api` o con `-w apps/api`.
