#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

MODE=""
WITH_DEMO_EVENTS=0
DEV_HA_AUTO_BOOTSTRAP="${DEV_HA_AUTO_BOOTSTRAP:-true}"
DEV_HA_TOKEN_FILE="${DEV_HA_TOKEN_FILE:-.dev-ha.token}"
TOKEN_SOURCE="unset"

if [[ -n "${HA_TOKEN:-}" ]]; then
  TOKEN_SOURCE="env"
fi

usage() {
  cat <<'USAGE'
Usage: bash scripts/run-collector-dev.sh --mode=lan|dev-ha [--with-demo-events]

Examples:
  yarn dev:collector --mode=lan
  yarn dev:collector --mode=dev-ha
  yarn dev:collector --mode=dev-ha --with-demo-events
USAGE
}

is_truthy() {
  local value="${1,,}"
  [[ "$value" == "1" || "$value" == "true" || "$value" == "yes" || "$value" == "on" ]]
}

for arg in "$@"; do
  case "$arg" in
    --mode=*)
      MODE="${arg#*=}"
      ;;
    --with-demo-events)
      WITH_DEMO_EVENTS=1
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ "$MODE" != "lan" && "$MODE" != "dev-ha" ]]; then
  echo "Error: --mode=lan|dev-ha is required." >&2
  usage
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required to run collector development flows." >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "'docker compose' is required to run collector development flows." >&2
  exit 1
fi

if ! command -v yarn >/dev/null 2>&1; then
  echo "yarn is required to run collector development flows." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node is required to run collector development flows." >&2
  exit 1
fi

wait_for_http_ready() {
  local url="$1"
  local max_attempts="$2"

  for _ in $(seq 1 "$max_attempts"); do
    local status_code
    status_code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "$url" || true)"
    if [[ "$status_code" =~ ^2[0-9][0-9]$ || "$status_code" =~ ^3[0-9][0-9]$ || "$status_code" == "401" || "$status_code" == "403" ]]; then
      return
    fi
    sleep 2
  done

  echo "Home Assistant did not become ready in time at '$url'." >&2
  exit 1
}

load_token_from_file_if_available() {
  if [[ -n "${HA_TOKEN:-}" ]]; then
    return
  fi

  if [[ ! -f "$DEV_HA_TOKEN_FILE" ]]; then
    return
  fi

  local token
  token="$(tr -d '\r\n' <"$DEV_HA_TOKEN_FILE")"
  if [[ -n "$token" ]]; then
    export HA_TOKEN="$token"
    TOKEN_SOURCE="file"
    echo "Loaded HA_TOKEN from ${DEV_HA_TOKEN_FILE}."
  fi
}

save_token_to_file() {
  local token="$1"
  umask 077
  printf "%s\n" "$token" >"$DEV_HA_TOKEN_FILE"
}

is_ha_token_valid() {
  local http_url="$1"
  local token="$2"
  local status_code

  status_code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 -H "Authorization: Bearer ${token}" "${http_url}/api/" || true)"
  [[ "$status_code" =~ ^2[0-9][0-9]$ || "$status_code" =~ ^3[0-9][0-9]$ ]]
}

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required to verify Home Assistant readiness." >&2
  exit 1
fi

echo "Ensuring local database services are running (postgres + pgAdmin)..."
bash scripts/run-db-dev.sh

if [[ "$MODE" == "lan" ]]; then
  export HA_WS_URL="${HA_WS_URL:-ws://homeassistant.local:8123/api/websocket}"
else
  export DEV_HA_HTTP_URL="${DEV_HA_HTTP_URL:-http://127.0.0.1:8123}"
  export DEV_HA_WS_URL="${DEV_HA_WS_URL:-ws://127.0.0.1:8123/api/websocket}"
  export HA_WS_URL="${HA_WS_URL:-$DEV_HA_WS_URL}"
  export DEV_HA_OWNER_NAME="${DEV_HA_OWNER_NAME:-HA AI Dev}"
  export DEV_HA_OWNER_USERNAME="${DEV_HA_OWNER_USERNAME:-ha_ai_dev}"
  export DEV_HA_OWNER_PASSWORD="${DEV_HA_OWNER_PASSWORD:-ha_ai_dev_password}"
  export DEV_HA_OWNER_LANGUAGE="${DEV_HA_OWNER_LANGUAGE:-en}"
  export DEV_HA_CLIENT_ID="${DEV_HA_CLIENT_ID:-${DEV_HA_HTTP_URL}/}"
  export DEV_HA_REDIRECT_URI="${DEV_HA_REDIRECT_URI:-${DEV_HA_HTTP_URL}/auth/external/callback}"
  export DEV_HA_TOKEN_CLIENT_NAME="${DEV_HA_TOKEN_CLIENT_NAME:-ha-ai-collector-dev}"
  export DEV_HA_TOKEN_LIFESPAN_DAYS="${DEV_HA_TOKEN_LIFESPAN_DAYS:-3650}"

  echo "Starting local development Home Assistant (profile: dev-ha)..."
  docker compose --profile dev-ha up -d homeassistant

  echo "Waiting for Home Assistant readiness at ${DEV_HA_HTTP_URL}..."
  wait_for_http_ready "$DEV_HA_HTTP_URL" 180

  load_token_from_file_if_available

  if [[ -n "${HA_TOKEN:-}" ]] && ! is_ha_token_valid "$DEV_HA_HTTP_URL" "$HA_TOKEN"; then
    echo "Current HA_TOKEN is not valid for local Home Assistant."
    if [[ "$TOKEN_SOURCE" == "file" ]]; then
      echo "Removing stale cached token at ${DEV_HA_TOKEN_FILE}."
      rm -f "$DEV_HA_TOKEN_FILE"
      unset HA_TOKEN
      TOKEN_SOURCE="unset"
    else
      echo "HA_TOKEN was provided by environment. Unset HA_TOKEN or provide a valid token for this Home Assistant instance." >&2
    fi
  fi

  if [[ -z "${HA_TOKEN:-}" ]] && is_truthy "$DEV_HA_AUTO_BOOTSTRAP"; then
    echo "HA_TOKEN not provided; attempting automatic local Home Assistant bootstrap..."
    if generated_token="$(node scripts/bootstrap-dev-ha-token.mjs)"; then
      if [[ -n "$generated_token" ]]; then
        export HA_TOKEN="$generated_token"
        TOKEN_SOURCE="bootstrap"
        save_token_to_file "$generated_token"
        echo "Generated and cached local Home Assistant token at ${DEV_HA_TOKEN_FILE}."
      fi
    fi
  fi
fi

if [[ -z "${HA_TOKEN:-}" ]]; then
  if [[ "$MODE" == "dev-ha" ]]; then
    cat <<'ONBOARD' >&2
HA_TOKEN is required.

Automatic bootstrap did not provide a token. If this is a brand-new volume, ensure:
  DEV_HA_AUTO_BOOTSTRAP=true

Manual fallback:
  1. Open http://127.0.0.1:8123 and complete account setup (if prompted).
  2. Go to your user profile and create a long-lived access token.
  3. Export it in your shell:
       export HA_TOKEN='<your-token>'
  4. Optional: persist for future dev-ha runs:
       printf '%s\n' "$HA_TOKEN" > .dev-ha.token && chmod 600 .dev-ha.token
  5. Rerun:
       yarn dev:collector --mode=dev-ha
ONBOARD
  else
    cat <<'LANMSG' >&2
HA_TOKEN is required for LAN mode.

Set your Home Assistant long-lived access token:
  export HA_TOKEN='<your-token>'

Then rerun:
  yarn dev:collector --mode=lan
LANMSG
  fi
  exit 1
fi

echo "Collector mode: $MODE"
echo "Collector HA websocket target: $HA_WS_URL"

DEMO_PID=""
if [[ "$WITH_DEMO_EVENTS" -eq 1 ]]; then
  if [[ "$MODE" != "dev-ha" ]]; then
    echo "--with-demo-events is only supported with --mode=dev-ha." >&2
    exit 1
  fi
  echo "Starting optional Home Assistant demo event emitter..."
  bash scripts/emit-ha-demo-events.sh &
  DEMO_PID="$!"
fi

cleanup() {
  if [[ -n "$DEMO_PID" ]]; then
    kill "$DEMO_PID" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT INT TERM

yarn workspace @ha-ai/collector start:collector
