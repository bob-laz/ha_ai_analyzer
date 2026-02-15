#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required to run integration tests." >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "'docker compose' is required to run integration tests." >&2
  exit 1
fi

TARGET="${1:-all}"
case "$TARGET" in
  all | collector | tools) ;;
  *)
    echo "Usage: $0 [all|collector|tools]" >&2
    exit 1
    ;;
esac

echo "Starting postgres service for integration tests..."
docker compose up -d postgres

CONTAINER_ID="$(docker compose ps -q postgres)"
if [[ -z "$CONTAINER_ID" ]]; then
  echo "Unable to resolve postgres container id from docker compose." >&2
  exit 1
fi

echo "Waiting for postgres to become healthy..."
for _ in {1..60}; do
  STATUS="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$CONTAINER_ID" 2>/dev/null || true)"
  if [[ "$STATUS" == "healthy" ]]; then
    break
  fi
  sleep 1
done

if [[ "${STATUS:-unknown}" != "healthy" ]]; then
  echo "Postgres did not become healthy in time (last status: ${STATUS:-unknown})." >&2
  exit 1
fi

export TEST_DATABASE_URL="${TEST_DATABASE_URL:-postgresql://ha_ai:ha_ai_dev_password@127.0.0.1:5432/ha_ai}"

case "$TARGET" in
  collector)
    yarn workspace @ha-ai/collector test
    ;;
  tools)
    yarn workspace @ha-ai/tools test
    ;;
  all)
    yarn workspace @ha-ai/collector test
    yarn workspace @ha-ai/tools test
    ;;
esac
