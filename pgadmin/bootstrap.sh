#!/bin/sh
set -eu

PGADMIN_DB_HOST="${PGADMIN_DB_HOST:-postgres}"
PGADMIN_DB_PORT="${PGADMIN_DB_PORT:-5432}"
PGADMIN_DB_USER="${PGADMIN_DB_USER:-ha_ai}"
PGADMIN_DB_PASSWORD="${PGADMIN_DB_PASSWORD:-ha_ai_dev_password}"

escaped_password="$(printf '%s' "$PGADMIN_DB_PASSWORD" | sed 's/[\\:]/\\&/g')"
printf '%s:%s:*:%s:%s\n' "$PGADMIN_DB_HOST" "$PGADMIN_DB_PORT" "$PGADMIN_DB_USER" "$escaped_password" > /var/lib/pgadmin/servers.pass
chmod 600 /var/lib/pgadmin/servers.pass

exec /entrypoint.sh
