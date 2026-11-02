#!/usr/bin/env bash
# Genera los archivos de UNA instancia (cliente) a partir de las plantillas. NO instala nada ni toca el servidor:
# escribe en ./instancias-out/<nombre>/ y muestra los pasos a ejecutar a mano con sudo.
# Uso:  ./deploy/scripts/instance-new.sh <nombre> <puerto> <panel-host> <api-host> [off|mock]
# Ej.:  ./deploy/scripts/instance-new.sh demod1 3001 demod1.apiworking.com.pe api.demod1.apiworking.com.pe mock
set -euo pipefail

NAME="${1:?Nombre de la instancia (a-z, 0-9), p. ej. demod1}"
PORT="${2:?Puerto local de la API, p. ej. 3001}"
PANEL_HOST="${3:?Host del panel, p. ej. demod1.apiworking.com.pe}"
API_HOST="${4:?Host de la API, p. ej. api.demod1.apiworking.com.pe}"
MODE="${5:-off}"

[[ "$NAME" =~ ^[a-z][a-z0-9]{1,30}$ ]] || { echo "Nombre inválido (a-z y 0-9, empieza con letra)" >&2; exit 1; }
[[ "$PORT" =~ ^[0-9]{4,5}$ ]] || { echo "Puerto inválido" >&2; exit 1; }
[[ "$MODE" == "off" || "$MODE" == "mock" ]] || { echo "Modo de integraciones: off o mock" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${OUT_DIR:-./instancias-out}/$NAME"
[[ -e "$OUT" ]] && { echo "Ya existe $OUT; bórrelo si quiere regenerarlo" >&2; exit 1; }
mkdir -p "$OUT"
umask 077

DB_NAME="apidental_$NAME"
DB_USER="app_$NAME"
DB_MIGRATE_USER="mig_$NAME"
# base64 url-safe: sin caracteres que rompan la URL de MySQL ni el archivo de entorno.
rand() { openssl rand -base64 "$1" | tr -d '\n=' | tr '+/' '-_'; }
DB_PASSWORD="$(rand 24)"
DB_MIGRATE_PASSWORD="$(rand 24)"
JWT_SECRET="$(rand 48)"

MOCK_FLAG=""
[[ "$MODE" == "mock" ]] && MOCK_FLAG="INTEGRATIONS_MOCK_ALLOW_PRODUCTION=true"

sed \
  -e "s|__NAME__|$NAME|g" -e "s|__PORT__|$PORT|g" -e "s|__PANEL_HOST__|$PANEL_HOST|g" \
  -e "s|__DB_NAME__|$DB_NAME|g" -e "s|__DB_USER__|$DB_USER|g" -e "s|__DB_PASSWORD__|$DB_PASSWORD|g" \
  -e "s|__DB_MIGRATE_USER__|$DB_MIGRATE_USER|g" -e "s|__DB_MIGRATE_PASSWORD__|$DB_MIGRATE_PASSWORD|g" \
  -e "s|__JWT_SECRET__|$JWT_SECRET|g" -e "s|__INTEGRATIONS_MODE__|$MODE|g" -e "s|__MOCK_PRODUCTION_FLAG__|$MOCK_FLAG|g" \
  "$HERE/env/instancia.env.template" > "$OUT/$NAME.env"

sed -e "s|__NAME__|$NAME|g" -e "s|__PORT__|$PORT|g" -e "s|__PANEL_HOST__|$PANEL_HOST|g" -e "s|__API_HOST__|$API_HOST|g" \
  "$HERE/nginx/apidental-instancia.conf.template" > "$OUT/apidental-$NAME.conf"

cat > "$OUT/crear-bd.sql" <<SQL
-- Ejecutar como administrador de MySQL: sudo mysql < crear-bd.sql
CREATE DATABASE \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER '$DB_MIGRATE_USER'@'127.0.0.1' IDENTIFIED BY '$DB_MIGRATE_PASSWORD';
CREATE USER '$DB_USER'@'127.0.0.1' IDENTIFIED BY '$DB_PASSWORD';
GRANT ALL PRIVILEGES ON \`$DB_NAME\`.* TO '$DB_MIGRATE_USER'@'127.0.0.1';
FLUSH PRIVILEGES;
-- Los permisos del usuario de la aplicación se dan DESPUÉS de migrar con permisos-app.sh (por tabla).
SQL
cat > "$OUT/permisos-app.sh" <<SH
#!/usr/bin/env bash
# Ejecutar DESPUÉS de migrar, en el servidor: sudo bash permisos-app.sh
# audit_logs (y _prisma_migrations) quedan fuera del permiso general: la app solo hace SELECT e INSERT en audit_logs.
set -euo pipefail
{
  mysql -N -e "SELECT CONCAT('GRANT SELECT, INSERT, UPDATE, DELETE ON \\\`$DB_NAME\\\`.\\\`', table_name, '\\\` TO ''$DB_USER''@''127.0.0.1'';') FROM information_schema.tables WHERE table_schema = '$DB_NAME' AND table_type = 'BASE TABLE' AND table_name NOT IN ('audit_logs', '_prisma_migrations');"
  echo "GRANT SELECT, INSERT ON \\\`$DB_NAME\\\`.\\\`audit_logs\\\` TO '$DB_USER'@'127.0.0.1';"
  echo "FLUSH PRIVILEGES;"
} | mysql
SH
chmod 600 "$OUT"/*

cat <<MSG
Archivos generados en $OUT (contienen secretos: no los suba a Git ni los comparta):
  $NAME.env  apidental-$NAME.conf  crear-bd.sql  permisos-app.sh

Pasos en el servidor (a mano, revisando cada uno):
  1. sudo mysql < $OUT/crear-bd.sql
  2. sudo install -m 600 -o root -g apidental $OUT/$NAME.env /etc/apidental/$NAME.env
  3. sudo install -d -m 700 -o apidental -g apidental /var/lib/apidental/$NAME/files
  4. Migre (sin arrancar aún): MIGRATE_ONLY=yes INSTANCES="$NAME" BACKUP_DONE=yes ./deploy/scripts/deploy.sh <tag>
  5. sudo bash $OUT/permisos-app.sh   (permisos por tabla del usuario de la app)
  6. Cree el administrador (con el usuario de migración):
       (cd /opt/apidental && eval "\$(grep '^MIGRATE_DATABASE_URL=' /etc/apidental/$NAME.env | sed 's/^MIGRATE_DATABASE_URL/export DATABASE_URL/')" && NODE_ENV=production npm run db:seed -w apps/api && NODE_ENV=production npm run db:create-admin -w apps/api -- --email <correo>)
  7. DNS: registros A de $PANEL_HOST y $API_HOST hacia el VPS; luego certbot para ambos hosts.
  8. sudo cp $OUT/apidental-$NAME.conf /etc/nginx/sites-available/ && sudo ln -s ../sites-available/apidental-$NAME.conf /etc/nginx/sites-enabled/ && sudo nginx -t && sudo systemctl reload nginx
  9. sudo systemctl enable --now apidental-api@$NAME apidental-maintenance@$NAME.timer
MSG
