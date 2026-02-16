#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-/opt/ha-ai/app}"
ENV_FILE="${ENV_FILE:-/opt/ha-ai/.env.prod}"
COMPOSE_FILE="${COMPOSE_FILE:-${APP_DIR}/docker-compose.prod.yml}"
BACKUP_DIR="${BACKUP_DIR:-/opt/ha-ai/backups}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

# shellcheck disable=SC1091
source "${SCRIPT_DIR}/common.sh"

require_command docker
if ! docker compose version >/dev/null 2>&1; then
  echo "docker compose plugin is required." >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Required env file not found: $ENV_FILE" >&2
  exit 1
fi

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "Required compose file not found: $COMPOSE_FILE" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

POSTGRES_DB="${POSTGRES_DB:-ha_ai}"
POSTGRES_USER="${POSTGRES_USER:-ha_ai}"

mkdir -p "$BACKUP_DIR"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_PATH="${BACKUP_DIR}/ha_ai_${TIMESTAMP}.dump"

echo "Creating postgres backup at ${BACKUP_PATH}..."
compose_cmd exec -T postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc >"$BACKUP_PATH"
chmod 600 "$BACKUP_PATH"

if [[ "$BACKUP_RETENTION_DAYS" =~ ^[0-9]+$ ]]; then
  find "$BACKUP_DIR" -type f -name 'ha_ai_*.dump' -mtime +"$BACKUP_RETENTION_DAYS" -delete
else
  echo "BACKUP_RETENTION_DAYS is not numeric; skipping cleanup." >&2
fi

echo "Backup completed successfully."
