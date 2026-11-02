# Una instalación por cliente (mismo código)

Un solo repositorio y un solo build. Cada cliente es una **instancia** con su propia BD, su `.env`, su puerto, su
directorio de adjuntos y sus dominios. No se comparten datos, secretos JWT ni credenciales de Apiworking.

| Instancia | Panel | API | Puerto | Servicio | BD | Uso |
|---|---|---|---|---|---|---|
| `dental` | `dental.apiworking.com.pe` | `api.dental.apiworking.com.pe` | 3100 | `apidental-api` | `apidental` | Dra. Gina Paredes Yauri (RUC 10074654016); tenant Apiworking `prod_ti_tiendaglowsmile` |
| `demod1` | `demod1.apiworking.com.pe` | `api.demod1.apiworking.com.pe` | 3101 | `apidental-api@demod1` | `apidental_demod1` | Demo / próximo cliente |
| `demod2` | `demod2.apiworking.com.pe` | `api.demod2.apiworking.com.pe` | 3102 | `apidental-api@demod2` | `apidental_demod2` | Demo / próximo cliente |

El VPS (`vision-support-vps`) es **compartido con otros proyectos** y usa **MariaDB 10.11**; los puertos 3000–3007, 4000–4011, 4100,
4310 y 5000 ya están ocupados. El código vive en `/var/www/apidental/app` (sin Git), el panel compartido en
`/var/www/apidental/admin`, y Node es `/var/www/apidental/node/bin/node`.

## Cómo se separa todo
- **BD:** `apidental_<nombre>`, con usuario de aplicación (`app_<nombre>`) y de migración (`mig_<nombre>`) distintos.
- **Entorno:** `/etc/apidental/<nombre>.env` (600). `JWT_ACCESS_SECRET`, `JWT_ISSUER` y `JWT_AUDIENCE` propios: un token de un cliente no vale en otro.
- **Adjuntos:** `/var/www/apidental/files/<nombre>` (la unidad systemd solo permite escribir ahí). `dental` conserva el esquema histórico (`/var/www/apidental/files`, `/etc/apidental/api.env`, servicio `apidental-api`).
- **Panel:** el build es el mismo para todos y llama a rutas relativas `/v1/...`; cada `server` de nginx las envía a su instancia.
- **Servicios:** `apidental-api@<nombre>` y `apidental-maintenance@<nombre>.timer`.

## Alta de un cliente
`./deploy/scripts/instance-new.sh <nombre> <puerto> <panel-host> <api-host> [off|mock]` genera el `.env`, el `server` de
nginx, el SQL de la BD y el script de permisos en `./instancias-out/<nombre>/` (contienen secretos; no se versionan) e
imprime los pasos a ejecutar a mano en el servidor. No toca el servidor.

## Despliegue
`./deploy/scripts/push.sh` (desde el equipo de desarrollo): compila una vez, sube por rsync a carpetas temporales, respalda
(mysqldump + `dist` y panel actuales), migra **todas** las BD antes de tocar el código, da permisos de las tablas nuevas,
intercambia el código y reinicia y comprueba cada instancia (si una no responde, devuelve el código anterior). `DRY_RUN=1` solo
muestra qué subiría. Los respaldos quedan en `/var/www/apidental/backups`.
Las migraciones usan `MIGRATE_DATABASE_URL` (usuario `mig_<nombre>`; en `dental`, `/etc/apidental/dental.migrate.env`), nunca el
usuario de la aplicación. El usuario de la app recibe CRUD por tabla y solo `SELECT, INSERT` sobre `audit_logs`.

## Estado (2026-11-02)
- Hecho: `dental`, `demod1` y `demod2` corren el mismo código con BD, `.env`, secreto JWT, puerto, certificado y adjuntos propios.
  `demod1` y `demod2` son **clones** de los datos que tenía `dental` (respaldo previo: `/var/www/apidental/backups/pre-instancias-apiworking-20261102-1650.sql`).
- **Pendiente (decisión del titular): dejar `dental` limpio para la Dra. Gina Paredes.** Hoy `dental` aún muestra los datos de
  demostración. Pasos: BD nueva `apidental_dental` (usuarios `app_dental`/`mig_dental`), migrar, `db:seed`, `db:create-clinic` con el
  RUC, variables `APIWORKING_*` en su `.env`, `db:create-admin` y `db:grant-role` (ver `apiworking-real.md`), y apuntar el servicio a
  ese `.env`. La BD `apidental` actual se conserva (respaldo) hasta confirmar.
- Sin mantenimiento programado todavía: instalar `apidental-maintenance@<nombre>.timer` por instancia cuando se carguen datos reales.
- Limitación: todas las instancias corren con el mismo usuario del sistema (`apidental`); el aislamiento es por BD, secretos y
  directorio, no por usuario de SO.

## Apiworking por cliente
Login con la cuenta de Apiworking, lectura de clientes y ventas por `registro-documento` están implementados: ver
[`apiworking-real.md`](apiworking-real.md). Cada instancia lleva en su `.env` su propio tenant, cajas, series y credenciales
(nunca se copian de otro cliente); las instancias de demostración (`demod1`, `demod2`) quedan con `AUTH_MODE=local`.
