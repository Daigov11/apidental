#!/usr/bin/env bash
# PLANTILLA de despliegue manual (SSH + Git). NO se ejecuta desde desarrollo.
# Uso en el VPS:  BACKUP_DONE=yes ./deploy/scripts/deploy.sh v0.1.0
set -euo pipefail

TAG="${1:?Indique el tag a desplegar, p. ej. v0.1.0}"
APP_DIR="${APP_DIR:-/opt/apidental}"
SERVICE="${SERVICE:-apidental-api}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/v1/health}"

if [[ "${BACKUP_DONE:-}" != "yes" ]]; then
  echo "Haga primero un respaldo de MySQL y archivos y ejecute con BACKUP_DONE=yes" >&2
  exit 1
fi

cd "$APP_DIR"
PREVIOUS="$(git describe --tags --always)"
echo "Versión actual: $PREVIOUS  ->  nueva: $TAG   (rollback: git checkout $PREVIOUS)"

git fetch --tags --prune
git checkout --detach "$TAG"
npm ci
npm run build
# Las migraciones requieren un usuario con DDL/TRIGGER (ver README, sección Producción).
npm run db:deploy -w apps/api
sudo systemctl restart "$SERVICE"

for i in {1..15}; do
  if curl -fsS "$HEALTH_URL" >/dev/null; then echo "Health OK"; exit 0; fi
  sleep 2
done
echo "El health check falló; revise: journalctl -u $SERVICE -n 100. Rollback: git checkout $PREVIOUS" >&2
exit 1
