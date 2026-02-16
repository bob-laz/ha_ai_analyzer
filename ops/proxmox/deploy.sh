#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

APP_DIR="${APP_DIR:-/opt/ha-ai/app}"
ENV_FILE="${ENV_FILE:-/opt/ha-ai/.env.prod}"
STATE_DIR="${STATE_DIR:-/opt/ha-ai/state}"
COMPOSE_FILE="${COMPOSE_FILE:-${APP_DIR}/docker-compose.prod.yml}"

# shellcheck disable=SC1091
source "${SCRIPT_DIR}/common.sh"

usage() {
  cat <<USAGE
Usage: ${BASH_SOURCE[0]} --tag sha-<commit>

Optional overrides:
  APP_DIR, ENV_FILE, STATE_DIR, COMPOSE_FILE
USAGE
}

TARGET_TAG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag=*)
      TARGET_TAG="${1#*=}"
      shift
      ;;
    --tag)
      if [[ $# -lt 2 ]]; then
        echo "--tag requires a value." >&2
        usage
        exit 1
      fi
      TARGET_TAG="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: ${1}" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$TARGET_TAG" ]]; then
  echo "--tag is required." >&2
  usage
  exit 1
fi

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

mkdir -p "$STATE_DIR"

if [[ -n "${GHCR_USERNAME:-}" && -n "${GHCR_TOKEN:-}" ]]; then
  echo "Logging in to GHCR using GHCR_USERNAME/GHCR_TOKEN..."
  printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USERNAME" --password-stdin >/dev/null
elif is_ghcr_login_configured; then
  echo "Using existing Docker auth configuration for ghcr.io."
else
  echo "GHCR login not configured. Run 'docker login ghcr.io' or provide GHCR_USERNAME/GHCR_TOKEN." >&2
  exit 1
fi

CURRENT_TAG="$(read_env_var IMAGE_TAG "$ENV_FILE" || true)"
if [[ -z "$CURRENT_TAG" ]]; then
  CURRENT_TAG="main-latest"
fi

REVERT_TAG="$CURRENT_TAG"
ROLLBACK_ON_ERROR=1
rollback_env() {
  if [[ "$ROLLBACK_ON_ERROR" -eq 1 ]]; then
    upsert_env_var IMAGE_TAG "$REVERT_TAG" "$ENV_FILE"
  fi
}
trap rollback_env ERR

echo "Current tag: ${CURRENT_TAG}"
echo "Target tag:  ${TARGET_TAG}"

if [[ "$TARGET_TAG" == "$CURRENT_TAG" ]]; then
  echo "Target tag matches current tag; proceeding with pull + restart."
fi

upsert_env_var IMAGE_TAG "$TARGET_TAG" "$ENV_FILE"

echo "Pulling updated images..."
compose_cmd pull

echo "Applying updated services..."
compose_cmd up -d

SERVICES=(postgres collector retention analytics pgadmin)
if ! wait_for_services 180 "${SERVICES[@]}"; then
  echo "One or more services failed to reach running/healthy state after deployment." >&2
  compose_cmd ps >&2 || true
  exit 1
fi

printf '%s\n' "$CURRENT_TAG" >"${STATE_DIR}/previous_tag"
printf '%s\n' "$TARGET_TAG" >"${STATE_DIR}/current_tag"

ROLLBACK_ON_ERROR=0
trap - ERR

echo "Deployment completed successfully."
compose_cmd ps
