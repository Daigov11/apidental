#!/usr/bin/env bash
# Despliegue desde el equipo de desarrollo al VPS (compila AQUÍ y sube con rsync; el servidor no tiene Git).
# Es el flujo real de producción: una sola compilación para todas las instancias.
#
#   ./deploy/scripts/push.sh                 # dental demod1 demod2
#   ./deploy/scripts/push.sh demod1          # solo esas instancias (el código es el mismo: ver nota abajo)
#   DRY_RUN=1 ./deploy/scripts/push.sh       # compila y muestra qué subiría; no cambia nada en el servidor
#
# Orden (si algo falla antes del paso 5, el servidor sigue con el código anterior):
#   1 compilar · 2 subir a carpetas temporales (dist.new, admin.new, prisma) · 3 respaldar (mysqldump + dist/admin actuales)
#   4 migrar TODAS las BD · 5 dar permisos de las tablas nuevas · 6 intercambiar código · 7 reiniciar y comprobar cada instancia
#   (si una instancia no responde, se devuelve el código anterior; las migraciones son aditivas y el código anterior las tolera).
# NOTA: dist y panel son compartidos, así que siempre se actualiza el código de TODAS las instancias; el argumento solo limita
# qué BD se migra y qué servicios se reinician.
set -euo pipefail

HOST="${SSH_HOST:-vision-support-vps}"
REMOTE="${REMOTE_DIR:-/var/www/apidental}"
INSTANCES="${*:-dental demod1 demod2}"
DRY="${DRY_RUN:-}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$HERE"

echo ">> 1. Compilando (npm run build)"
npm run build >/dev/null
[[ -f apps/api/dist/main.js && -f apps/admin/dist/index.html ]] || { echo "La compilación no generó dist" >&2; exit 1; }

echo ">> 2. Subiendo a carpetas temporales de $HOST:$REMOTE"
RS=(rsync -rlt --delete)
[[ -n "$DRY" ]] && RS+=(-n -v)
"${RS[@]}" apps/api/dist/ "$HOST:$REMOTE/app/apps/api/dist.new/"
"${RS[@]}" --exclude 'seed*.ts' --exclude 'demo-*.ts' --exclude 'shift-demo*' apps/api/prisma/ "$HOST:$REMOTE/app/apps/api/prisma/"
"${RS[@]}" apps/admin/dist/ "$HOST:$REMOTE/admin.new/"
if [[ -n "$DRY" ]]; then echo "DRY_RUN: no se ejecutan los pasos 3 a 7."; exit 0; fi
rsync -rlt apps/api/prisma.config.ts "$HOST:$REMOTE/app/apps/api/prisma.config.ts"

echo ">> 3 a 7. En el servidor"
ssh -o BatchMode=yes "$HOST" bash -s -- "$REMOTE" $INSTANCES <<'REMOTE_SCRIPT'
set -euo pipefail
R="$1"; shift
TS="$(date +%Y%m%d-%H%M)"
API="$R/app/apps/api"
export PATH="$R/node/bin:$PATH"
chown -R root:root "$API/dist.new" "$API/prisma" "$API/prisma.config.ts" "$R/admin.new"
chmod -R u=rwX,go=rX "$API/dist.new" "$API/prisma" "$API/prisma.config.ts" "$R/admin.new"

# Dónde vive cada instancia (dental conserva el esquema histórico: api.env y apidental-api).
envfile()  { [[ "$1" == dental ]] && echo /etc/apidental/api.env || echo "/etc/apidental/$1.env"; }
service()  { [[ "$1" == dental ]] && echo apidental-api || echo "apidental-api@$1"; }
migurl()   { if [[ "$1" == dental ]]; then cut -d= -f2- /etc/apidental/dental.migrate.env; else grep -m1 '^MIGRATE_DATABASE_URL=' "/etc/apidental/$1.env" | cut -d= -f2-; fi; }
getenv()   { grep -m1 "^$2=" "$1" | cut -d= -f2-; }
dbname()   { local u; u="$(getenv "$(envfile "$1")" DATABASE_URL)"; echo "${u##*/}"; }
dbuser()   { local u; u="$(getenv "$(envfile "$1")" DATABASE_URL)"; u="${u#mysql://}"; echo "${u%%:*}"; }

echo "-- 3. Respaldos ($TS)"
for n in "$@"; do mysqldump --single-transaction --routines --triggers --events "$(dbname "$n")" > "$R/backups/pre-push-$TS-$n.sql"; chmod 600 "$R/backups/pre-push-$TS-$n.sql"; done
cp -a "$API/dist" "$API/dist.prev-$TS"
cp -a "$R/admin" "$R/admin.prev-$TS"

echo "-- 4. Migraciones (todas las BD antes de tocar el código)"
for n in "$@"; do
  echo "   [$n] $(dbname "$n")"
  (cd "$API" && DATABASE_URL="$(migurl "$n")" ../../node_modules/.bin/prisma migrate deploy 2>&1 | grep -E "have been applied|No pending|successfully|Error|error" || true)
done

echo "-- 5. Permisos de las tablas nuevas (CRUD; audit_logs solo SELECT/INSERT)"
for n in "$@"; do
  db="$(dbname "$n")"; au="$(dbuser "$n")"
  mysql -N -e "SELECT table_name FROM information_schema.tables WHERE table_schema='$db' AND table_type='BASE TABLE' AND table_name NOT IN ('audit_logs','_prisma_migrations')" | while read -r t; do
    mysql -N -e "SHOW GRANTS FOR \`$au\`@\`localhost\`" | grep -q "\`$db\`.\`$t\`" || { mysql -e "GRANT SELECT, INSERT, UPDATE, DELETE ON \`$db\`.\`$t\` TO \`$au\`@\`localhost\`"; echo "   [$n] permiso a $t"; }
  done
done
mysql -e "FLUSH PRIVILEGES"

echo "-- 6. Intercambio de código"
mv "$API/dist" "$API/dist.old-swap" && mv "$API/dist.new" "$API/dist"
mv "$R/admin" "$R/admin.old-swap" && mv "$R/admin.new" "$R/admin"

echo "-- 7. Reinicio y comprobación"
failed=""
for n in "$@"; do
  systemctl restart "$(service "$n")"
  port="$(getenv "$(envfile "$n")" PORT)"; ok=no
  for _ in $(seq 1 15); do curl -fsS "http://127.0.0.1:$port/v1/health" >/dev/null 2>&1 && { ok=yes; break; }; sleep 2; done
  echo "   [$n] puerto $port: $ok"
  [[ "$ok" == yes ]] || failed="$failed $n"
done
if [[ -n "$failed" ]]; then
  echo "FALLARON:$failed -> devolviendo el código anterior" >&2
  rm -rf "$API/dist" "$R/admin"; mv "$API/dist.old-swap" "$API/dist"; mv "$R/admin.old-swap" "$R/admin"
  for n in "$@"; do systemctl restart "$(service "$n")"; done
  exit 1
fi
echo "Todo OK. Para liberar espacio, cuando esté conforme: rm -rf $API/dist.old-swap $R/admin.old-swap"
REMOTE_SCRIPT
