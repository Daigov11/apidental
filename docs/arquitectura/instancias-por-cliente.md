# Una instalación por cliente (mismo código)

Un solo repositorio y un solo build. Cada cliente es una **instancia** con su propia BD, su `.env`, su puerto, su
directorio de adjuntos y sus dominios. No se comparten datos, secretos JWT ni credenciales de Apiworking.

| Instancia | Panel | API | Puerto | Uso |
|---|---|---|---|---|
| `dental` | `dental.apiworking.com.pe` | `api.dental.apiworking.com.pe` | 3000 | Dra. Gina Paredes Yauri (RUC 10074654016); tenant Apiworking `prod_ti_tiendaglowsmile` |
| `demod1` | `demod1.apiworking.com.pe` | `api.demod1.apiworking.com.pe` | 3001 | Demo / próximo cliente |
| `demod2` | `demod2.apiworking.com.pe` | `api.demod2.apiworking.com.pe` | 3002 | Demo / próximo cliente |

## Cómo se separa todo
- **BD:** `apidental_<nombre>`, con usuario de aplicación (`app_<nombre>`) y de migración (`mig_<nombre>`) distintos.
- **Entorno:** `/etc/apidental/<nombre>.env` (600). `JWT_ACCESS_SECRET`, `JWT_ISSUER` y `JWT_AUDIENCE` propios: un token de un cliente no vale en otro.
- **Adjuntos:** `/var/lib/apidental/<nombre>/files` (la unidad systemd solo permite escribir ahí).
- **Panel:** el build es el mismo para todos y llama a rutas relativas `/v1/...`; cada `server` de nginx las envía a su instancia.
- **Servicios:** `apidental-api@<nombre>` y `apidental-maintenance@<nombre>.timer`.

## Alta de un cliente
`./deploy/scripts/instance-new.sh <nombre> <puerto> <panel-host> <api-host> [off|mock]` genera el `.env`, el `server` de
nginx, el SQL de la BD y el script de permisos en `./instancias-out/<nombre>/` (contienen secretos; no se versionan) e
imprime los pasos a ejecutar a mano en el servidor. No toca el servidor.

## Despliegue
`BACKUP_DONE=yes ./deploy/scripts/deploy.sh <tag>` compila una vez, migra **todas** las BD antes de reiniciar ninguna
(con `MIGRATE_DATABASE_URL`) y luego reinicia y comprueba cada instancia. `INSTANCES="demod1"` limita el alcance.

## Migrar la instalación actual (`apidental-api` → `apidental-api@dental`)
La instalación actual (`apidental-api.service`, `/etc/apidental/api.env`, `/var/lib/apidental/files`) funciona sin
cambios. Para pasarla al esquema por instancia, en una ventana de mantenimiento y con respaldo: copiar `api.env` a
`dental.env` (añadiendo `MIGRATE_DATABASE_URL`), mover los adjuntos a `/var/lib/apidental/dental/files`, actualizar
`ATTACHMENTS_DIR`, parar `apidental-api` y arrancar `apidental-api@dental`.

Atención: **los datos actuales de `dental` son los de las demos**. Antes de pasar `dental` a Gina hay que copiarlos a
las BD de `demod1`/`demod2` (`mysqldump` + restaurar, con adjuntos) y dejar `dental` con una BD nueva y limpia.

## Apiworking por cliente
Login con la cuenta de Apiworking, lectura de clientes y ventas por `registro-documento` están implementados: ver
[`apiworking-real.md`](apiworking-real.md). Cada instancia lleva en su `.env` su propio tenant, cajas, series y credenciales
(nunca se copian de otro cliente); las instancias de demostración (`demod1`, `demod2`) quedan con `AUTH_MODE=local`.
