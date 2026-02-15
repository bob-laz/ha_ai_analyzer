#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

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
echo "pgAdmin available at http://127.0.0.1:5050 (default login: admin@example.com / admin)"
echo "Registered pgAdmin server: ha_ai_postgres (host: postgres, database: ha_ai, user: ha_ai)"
