#!/usr/bin/env bash
# PLANTILLA de despliegue manual (SSH + Git). NO se ejecuta desde desarrollo.
# Un solo código para todos los clientes: se compila UNA vez y se migra/reinicia cada instancia.
# Uso en el VPS:  BACKUP_DONE=yes ./deploy/scripts/deploy.sh v0.1.0
#   INSTANCES="demod1 demod2"  limita el despliegue a esas instancias (por defecto: dental demod1 demod2).
#   MIGRATE_ONLY=yes           solo migra (alta de un cliente nuevo: aún faltan los permisos de la app).
# Cada instancia lee /etc/apidental/<nombre>.env y el puerto de su PORT (debe coincidir con el de nginx).
set -euo pipefail

TAG="${1:?Indique el tag a desplegar, p. ej. v0.1.0}"
APP_DIR="${APP_DIR:-/opt/apidental}"
ENV_DIR="${ENV_DIR:-/etc/apidental}"
INSTANCES="${INSTANCES:-dental demod1 demod2}"
SERVICE_PREFIX="${SERVICE_PREFIX:-apidental-api@}"

if [[ "${BACKUP_DONE:-}" != "yes" ]]; then
  echo "Haga primero un respaldo de MySQL y archivos de CADA instancia y ejecute con BACKUP_DONE=yes" >&2
  exit 1
fi

# Lee una variable de un archivo de entorno sin cargarlo en el shell (así no se mezclan secretos entre instancias).
env_get() { sudo grep -m1 "^$2=" "$1" | cut -d= -f2-; }

cd "$APP_DIR"
PREVIOUS="$(git describe --tags --always)"
echo "Versión actual: $PREVIOUS  ->  nueva: $TAG   (rollback: git checkout $PREVIOUS)"

git fetch --tags --prune
git checkout --detach "$TAG"
npm ci
npm run build

# 1) Migrar TODAS las bases antes de reiniciar cualquiera: si una migración falla, ninguna instancia queda
#    con código nuevo sobre un esquema viejo. Las migraciones usan MIGRATE_DATABASE_URL (usuario con DDL/TRIGGER).
for name in $INSTANCES; do
  file="$ENV_DIR/$name.env"
  url="$(env_get "$file" MIGRATE_DATABASE_URL)"
  [[ -n "$url" ]] || { echo "[$name] Falta MIGRATE_DATABASE_URL en $file" >&2; exit 1; }
  echo "[$name] migrando…"
  DATABASE_URL="$url" npm run db:deploy -w apps/api
done

[[ "${MIGRATE_ONLY:-}" == "yes" ]] && { echo "Migraciones aplicadas (MIGRATE_ONLY)."; exit 0; }

# 2) Reiniciar y comprobar cada instancia.
failed=()
for name in $INSTANCES; do
  port="$(env_get "$ENV_DIR/$name.env" PORT)"
  echo "[$name] reiniciando (puerto $port)…"
  sudo systemctl restart "$SERVICE_PREFIX$name"
  ok=no
  for _ in {1..15}; do
    if curl -fsS "http://127.0.0.1:$port/v1/health" >/dev/null; then ok=yes; break; fi
    sleep 2
  done
  [[ "$ok" == "yes" ]] && echo "[$name] Health OK" || { echo "[$name] Health FALLÓ; revise: journalctl -u $SERVICE_PREFIX$name -n 100" >&2; failed+=("$name"); }
done

if ((${#failed[@]})); then
  echo "Fallaron: ${failed[*]}. Rollback: git checkout $PREVIOUS (y reiniciar las instancias)" >&2
  exit 1
fi
echo "Todas las instancias OK."
