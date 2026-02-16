#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "bootstrap.sh must be run as root." >&2
  exit 1
fi

APP_DIR="${APP_DIR:-/opt/ha-ai/app}"
STATE_DIR="${STATE_DIR:-/opt/ha-ai/state}"
BACKUP_DIR="${BACKUP_DIR:-/opt/ha-ai/backups}"
LAN_CIDR="${LAN_CIDR:-192.168.0.0/16}"
PGADMIN_LAN_PORT="${PGADMIN_LAN_PORT:-5050}"
UI_LAN_PORT="${UI_LAN_PORT:-5080}"
APP_OWNER="${APP_OWNER:-${SUDO_USER:-root}}"

if [[ -f /etc/os-release ]]; then
  # shellcheck disable=SC1091
  source /etc/os-release
else
  echo "Unable to determine OS from /etc/os-release." >&2
  exit 1
fi

if [[ "${ID:-}" != "debian" ]]; then
  echo "This bootstrap script targets Debian. Detected ID='${ID:-unknown}'." >&2
  exit 1
fi

echo "Installing Docker Engine and Compose plugin..."
apt-get update
apt-get install -y ca-certificates curl gnupg ufw

install -m 0755 -d /etc/apt/keyrings
if [[ ! -f /etc/apt/keyrings/docker.asc ]]; then
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
fi

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian ${VERSION_CODENAME} stable" \
  >/etc/apt/sources.list.d/docker.list

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker

echo "Creating app directories..."
install -d -m 0750 "$APP_DIR" "$STATE_DIR" "$BACKUP_DIR"
if id -u "$APP_OWNER" >/dev/null 2>&1; then
  chown -R "$APP_OWNER":"$APP_OWNER" /opt/ha-ai
fi

echo "Configuring firewall (UFW)..."
ufw --force default deny incoming
ufw --force default allow outgoing
ufw allow OpenSSH
ufw allow from "$LAN_CIDR" to any port "$PGADMIN_LAN_PORT" proto tcp
ufw allow from "$LAN_CIDR" to any port "$UI_LAN_PORT" proto tcp
ufw --force enable

echo "Installing helper commands..."
cat >/usr/local/bin/ha-ai-deploy <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
cd /opt/ha-ai/app
exec ./ops/proxmox/deploy.sh "$@"
SCRIPT

cat >/usr/local/bin/ha-ai-rollback <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
cd /opt/ha-ai/app
exec ./ops/proxmox/rollback.sh "$@"
SCRIPT

cat >/usr/local/bin/ha-ai-status <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
cd /opt/ha-ai/app
exec docker compose -f docker-compose.prod.yml --env-file /opt/ha-ai/.env.prod ps
SCRIPT

chmod +x /usr/local/bin/ha-ai-deploy /usr/local/bin/ha-ai-rollback /usr/local/bin/ha-ai-status

echo "Bootstrap complete."
echo "- Place repo contents at $APP_DIR"
echo "- Create /opt/ha-ai/.env.prod from .env.prod.example"
echo "- Run: ha-ai-deploy --tag sha-<commit>"
