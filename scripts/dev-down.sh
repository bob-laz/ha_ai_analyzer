#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required to tear down local services." >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "'docker compose' is required to tear down local services." >&2
  exit 1
fi

echo "Stopping local services and removing volumes for all local dev profiles..."
docker compose --profile debug --profile dev-ha --profile analytics --profile ui down -v --remove-orphans

echo "Local compose stack torn down."
