#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Load repo-local .env values for local DB + pgAdmin defaults.
if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

POSTGRES_DB="${POSTGRES_DB:-ha_ai}"
POSTGRES_USER="${POSTGRES_USER:-ha_ai}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-ha_ai_dev_password}"

PGADMIN_DEFAULT_EMAIL="${PGADMIN_DEFAULT_EMAIL:-admin@example.com}"
PGADMIN_DEFAULT_PASSWORD="${PGADMIN_DEFAULT_PASSWORD:-admin}"
PGADMIN_DB_HOST="${PGADMIN_DB_HOST:-postgres}"
PGADMIN_DB_PORT="${PGADMIN_DB_PORT:-5432}"
PGADMIN_DB_NAME="${PGADMIN_DB_NAME:-$POSTGRES_DB}"
PGADMIN_DB_USER="${PGADMIN_DB_USER:-$POSTGRES_USER}"
PGADMIN_DB_PASSWORD="${PGADMIN_DB_PASSWORD:-$POSTGRES_PASSWORD}"

export POSTGRES_DB
export POSTGRES_USER
export POSTGRES_PASSWORD
export PGADMIN_DEFAULT_EMAIL
export PGADMIN_DEFAULT_PASSWORD
export PGADMIN_DB_HOST
export PGADMIN_DB_PORT
export PGADMIN_DB_NAME
export PGADMIN_DB_USER
export PGADMIN_DB_PASSWORD

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required to run local database services." >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "'docker compose' is required to run local database services." >&2
  exit 1
fi

wait_for_service_health() {
  local service="$1"
  local max_attempts="$2"
  local status=""

  local container_id
  container_id="$(docker compose ps -q "$service")"
  if [[ -z "$container_id" ]]; then
    echo "Unable to resolve container id for service '$service'." >&2
    exit 1
  fi

  for _ in $(seq 1 "$max_attempts"); do
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id" 2>/dev/null || true)"
    if [[ "$status" == "healthy" ]]; then
      return
    fi
    sleep 1
  done

  echo "Service '$service' did not become healthy in time (last status: ${status:-unknown})." >&2
  exit 1
}

ensure_pgadmin_running() {
  local output=""

  if output="$(docker compose --profile debug up -d pgadmin 2>&1)"; then
    printf "%s\n" "$output"
    return
  fi

  printf "%s\n" "$output" >&2
  if [[ "$output" == *"network"* && "$output" == *"not found"* ]]; then
    echo "Detected stale Docker network reference for pgAdmin; recreating pgAdmin container..." >&2
    docker compose rm -f -s pgadmin >/dev/null 2>&1 || true
    docker compose --profile debug up -d --force-recreate pgadmin
    return
  fi

  echo "Unable to start pgAdmin." >&2
  exit 1
}

echo "Ensuring postgres is running and healthy..."
docker compose up -d postgres
wait_for_service_health postgres 90

echo "Ensuring pgAdmin is running (profile: debug)..."
ensure_pgadmin_running

echo "Postgres ready at localhost:5432"
echo "pgAdmin available at http://127.0.0.1:5050 (default login: ${PGADMIN_DEFAULT_EMAIL} / ${PGADMIN_DEFAULT_PASSWORD})"
echo "Registered pgAdmin server: ha_ai_postgres (host: ${PGADMIN_DB_HOST}, database: ${PGADMIN_DB_NAME}, user: ${PGADMIN_DB_USER})"
