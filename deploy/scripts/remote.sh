#!/usr/bin/env bash
# Corre un comando de administración (db:*) contra la BD de UNA instancia del VPS, desde el equipo de desarrollo.
# Abre un túnel SSH al MariaDB del servidor, lee MIGRATE_DATABASE_URL del .env de la instancia (las credenciales no se imprimen)
# y cierra el túnel al terminar. El servidor no necesita tsx.
#
#   ./deploy/scripts/remote.sh dental db:create-admin --email admin@clinica.pe     # pide la contraseña sin eco (use su terminal)
#   ./deploy/scripts/remote.sh dental db:grant-role --username system --role CLINIC_ADMIN --clinic <id>
#   ./deploy/scripts/remote.sh dental db:seed                                       # sincroniza el catálogo de roles/permisos
#   ./deploy/scripts/remote.sh dental db:create-clinic --name "..." --ruc 10074654016
# Tras desplegar permisos nuevos, ejecute db:seed en CADA instancia (sincroniza roles y permisos).
set -euo pipefail

NAME="${1:?Instancia (dental, demod1, demod2…)}"; SCRIPT="${2:?Comando: db:seed | db:create-admin | db:create-clinic | db:grant-role}"; shift 2
case "$SCRIPT" in db:seed|db:create-admin|db:create-clinic|db:grant-role) ;; *) echo "Comando no permitido: $SCRIPT" >&2; exit 1 ;; esac
[[ "$NAME" =~ ^[a-z][a-z0-9]{1,30}$ ]] || { echo "Nombre de instancia inválido" >&2; exit 1; }

HOST="${SSH_HOST:-vision-support-vps}"
PORT="${TUNNEL_PORT:-33061}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

VARS="$(ssh -o BatchMode=yes "$HOST" "grep -E '^(MIGRATE_DATABASE_URL|APIWORKING_AUTHZ_EXPECTED_DATABASE)=' /etc/apidental/$NAME.env")"
URL="$(sed -n 's/^MIGRATE_DATABASE_URL=//p' <<<"$VARS")"
[[ -n "$URL" ]] || { echo "No hay MIGRATE_DATABASE_URL en /etc/apidental/$NAME.env" >&2; exit 1; }
TENANT="$(sed -n 's/^APIWORKING_AUTHZ_EXPECTED_DATABASE=//p' <<<"$VARS")"

ssh -o BatchMode=yes -o ExitOnForwardFailure=yes -N -L "$PORT:127.0.0.1:3306" "$HOST" </dev/null &
TUNNEL=$!
trap 'kill $TUNNEL 2>/dev/null || true' EXIT
for _ in {1..20}; do (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null && break; sleep 0.3; done

cd "$HERE/apps/api"
DATABASE_URL="${URL/@127.0.0.1:3306\//@127.0.0.1:$PORT/}" NODE_ENV=production APIWORKING_AUTHZ_EXPECTED_DATABASE="$TENANT" npm run "$SCRIPT" --silent -- "$@"
