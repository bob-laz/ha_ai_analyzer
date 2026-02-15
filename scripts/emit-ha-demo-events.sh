#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${HA_TOKEN:-}" ]]; then
  echo "HA_TOKEN is required to emit demo Home Assistant events." >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required to emit demo Home Assistant events." >&2
  exit 1
fi

DEV_HA_HTTP_URL="${DEV_HA_HTTP_URL:-http://127.0.0.1:8123}"
DEV_HA_DEMO_INTERVAL_SECONDS="${DEV_HA_DEMO_INTERVAL_SECONDS:-10}"

if ! [[ "$DEV_HA_DEMO_INTERVAL_SECONDS" =~ ^[0-9]+$ ]] || [[ "$DEV_HA_DEMO_INTERVAL_SECONDS" -le 0 ]]; then
  echo "DEV_HA_DEMO_INTERVAL_SECONDS must be a positive integer." >&2
  exit 1
fi

echo "Emitting Home Assistant demo events to ${DEV_HA_HTTP_URL} every ${DEV_HA_DEMO_INTERVAL_SECONDS}s..."

counter=1
while true; do
  now_utc="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  message="ha-ai demo event #${counter} at ${now_utc}"

  curl -fsS \
    -X POST \
    -H "Authorization: Bearer ${HA_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"title\":\"HA AI Demo\",\"message\":\"${message}\"}" \
    "${DEV_HA_HTTP_URL}/api/services/persistent_notification/create" >/dev/null

  echo "Emitted demo event #${counter}"
  counter=$((counter + 1))
  sleep "$DEV_HA_DEMO_INTERVAL_SECONDS"
done
