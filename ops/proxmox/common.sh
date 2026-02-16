#!/usr/bin/env bash

require_command() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Required command '$cmd' is not installed." >&2
    exit 1
  fi
}

read_env_var() {
  local key="$1"
  local env_file="$2"
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, "", $0); print $0; exit }' "$env_file"
}

upsert_env_var() {
  local key="$1"
  local value="$2"
  local env_file="$3"

  if grep -qE "^${key}=" "$env_file"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$env_file"
  else
    printf '\n%s=%s\n' "$key" "$value" >>"$env_file"
  fi
}

is_ghcr_login_configured() {
  local docker_config_dir="${DOCKER_CONFIG:-$HOME/.docker}"
  local config_file="${docker_config_dir}/config.json"

  [[ -f "$config_file" ]] && grep -q '"ghcr.io"' "$config_file"
}

compose_cmd() {
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}

compose_up_with_network_recovery() {
  local output=""

  if output="$(compose_cmd up -d 2>&1)"; then
    printf '%s\n' "$output"
    return 0
  fi

  printf '%s\n' "$output" >&2

  if [[ "$output" == *"failed to set up container networking"* && "$output" == *"network"* && "$output" == *"not found"* ]]; then
    echo "Detected stale Docker network reference. Recreating compose network and containers..." >&2
    compose_cmd down --remove-orphans || true
    compose_cmd up -d --force-recreate
    return 0
  fi

  return 1
}

wait_for_services() {
  local timeout_seconds="$1"
  shift
  local services=("$@")

  local attempt=0
  while (( attempt < timeout_seconds )); do
    local all_ready=1

    for service in "${services[@]}"; do
      local container_id
      container_id="$(compose_cmd ps -q "$service")"
      if [[ -z "$container_id" ]]; then
        all_ready=0
        break
      fi

      local state
      state="$(docker inspect --format '{{.State.Status}}' "$container_id" 2>/dev/null || true)"
      if [[ "$state" != "running" ]]; then
        all_ready=0
        break
      fi

      local health
      health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container_id" 2>/dev/null || true)"
      if [[ "$health" != "none" && "$health" != "healthy" ]]; then
        all_ready=0
        break
      fi
    done

    if [[ "$all_ready" -eq 1 ]]; then
      return 0
    fi

    attempt=$((attempt + 1))
    sleep 1
  done

  return 1
}
