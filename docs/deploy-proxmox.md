# Proxmox Deployment Guide (Debian 13 VM)

This is the simplified runbook for first-time setup and updates.

Goal:
- Run `collector`, `retention`, `automation-snapshots`, `analytics`, `daily-home-summary`, `postgres`, `pgadmin`, `ui` on one Debian 13 VM.
- Connect collector to Home Assistant OS (HAOS) running on a different VM on the same Proxmox host.
- Deploy updates by running one command with a new image tag.

## What you need before starting

Write these values down first:

- `APP_VM_IP`: IP of Debian app VM (example `192.168.1.60`)
- `HAOS_VM_IP`: IP of HAOS VM (example `192.168.1.50`)
- `LAN_CIDR`: your LAN subnet (example `192.168.1.0/24`)
- `HA_TOKEN`: long-lived HA token from your HA user profile
- `OPENAI_API_KEY`
- Strong passwords:
  - `POSTGRES_PASSWORD`
  - `PGADMIN_DEFAULT_PASSWORD`
  - `UI_BASIC_AUTH_PASSWORD`
- A GHCR image tag to deploy:
  - production: `sha-<commit>`
  - PR testing: `pr-<number>-sha-<short-sha>`

## 1) Create the Debian VM in Proxmox (one time)

These steps assume Proxmox VE 9.x Web UI.

### 1.1 Upload Debian 13 ISO to Proxmox

Get the ISO from Debian official sources:

- Debian installer downloads page: [https://www.debian.org/distrib/](https://www.debian.org/distrib/)
- Netinst page (recommended for VM): [https://www.debian.org/distrib/netinst](https://www.debian.org/distrib/netinst)
- Direct ISO directory (amd64): [https://cdimage.debian.org/debian-cd/current/amd64/iso-cd/](https://cdimage.debian.org/debian-cd/current/amd64/iso-cd/)

Recommended image:

- `debian-13.0.0-amd64-netinst.iso` (or the latest `debian-13.x.x-amd64-netinst.iso` in the directory above)

Optional but recommended checksum verify before upload:

```bash
# Run on your laptop/workstation where you downloaded the ISO.
cd /path/to/downloads
sha256sum debian-13.0.0-amd64-netinst.iso
curl -fsSLO https://cdimage.debian.org/debian-cd/current/amd64/iso-cd/SHA256SUMS
grep debian-13.0.0-amd64-netinst.iso SHA256SUMS
```

Ensure the hash from `sha256sum` matches the value in `SHA256SUMS`.

1. In Proxmox UI, open your node.
2. Open the storage where ISOs live (commonly `local`).
3. Go to `ISO Images`.
4. Click `Upload`, select your Debian 13 netinst ISO, upload it.

### 1.2 Create the VM in Proxmox UI

1. Click `Create VM`.
2. `General` tab:
   - Node: choose your Proxmox node
   - VM ID: pick next available
   - Name: `ha-ai-prod` (recommended)
3. `OS` tab:
   - Use CD/DVD disc image file (iso)
   - ISO image: Debian 13 ISO you uploaded
   - Guest OS type: `Linux`
4. `System` tab:
   - Machine: `q35` (recommended)
   - BIOS: default is fine (`SeaBIOS` is fine)
   - SCSI Controller: default (`VirtIO SCSI single`) is fine
   - Enable `QEMU Agent` if available
5. `Disks` tab:
   - Bus/Device: `SCSI`
   - Disk size: `40 GiB` minimum (more if you want longer retention)
   - Storage: your fast/local SSD storage if available
6. `CPU` tab:
   - Cores: `2` minimum (`4` preferred)
   - Type: `x86-64-v2-AES` (or your node default)
7. `Memory` tab:
   - Memory: `4096 MiB` minimum (`8192 MiB` preferred)
8. `Network` tab:
   - Bridge: your LAN bridge (commonly `vmbr0`)
   - Model: `VirtIO (paravirtualized)`
   - VLAN tag: set if your LAN uses VLANs
9. Click `Finish`.

### 1.3 Install Debian in the VM

1. Start the VM.
2. Open `Console`.
3. Run Debian installer with defaults unless you have local standards.
4. Create your admin user.
5. Reboot into installed Debian and remove ISO from boot order if needed.

### 1.4 Post-install bootstrap inside Debian

Log in to the Debian VM and run:

```bash
sudo apt-get update
sudo apt-get upgrade -y
sudo apt-get install -y qemu-guest-agent curl ca-certificates git
sudo systemctl enable --now qemu-guest-agent
```

Recommended after install:

- Set a static DHCP reservation for this VM in your router/DHCP server.
- Confirm VM can resolve DNS and reach internet (`github.com`, `ghcr.io`).
- If HAOS is on a separate VM, ensure both VMs are on reachable bridge/VLAN networks.

## 2) Verify app VM can reach HAOS VM

From the Debian app VM:

```bash
HAOS_IP=192.168.1.50
ping -c 3 "$HAOS_IP"
curl -I --max-time 5 "http://${HAOS_IP}:8123/"
```

Expected:

- `ping` succeeds (or is blocked but next command succeeds).
- `curl` returns `200`, `302`, `401`, or `403`.

If this fails, fix networking before continuing:

- Ensure both VMs are on reachable bridge/VLAN.
- Check Proxmox firewall rules at Datacenter, Node, and VM levels.
- Ensure HAOS is actually listening on `8123`.

## 3) Put this repo on the VM

Option A: clone directly on VM:

```bash
sudo mkdir -p /opt/ha-ai
sudo chown "$USER":"$USER" /opt/ha-ai
cd /opt/ha-ai
git clone https://github.com/bob-laz/ha_ai_analyzer app
cd /opt/ha-ai/app
```

Option B: copy your local checkout to VM (use your preferred method), then ensure code ends up in:

- `/opt/ha-ai/app`

## 4) Run one-time bootstrap script

From VM:

```bash
cd /opt/ha-ai/app
sudo APP_OWNER="$USER" LAN_CIDR=192.168.1.0/24 PGADMIN_LAN_PORT=5050 UI_LAN_PORT=5080 ./ops/proxmox/bootstrap.sh
```

This installs and configures:

- Docker Engine + Compose plugin
- directories:
  - `/opt/ha-ai/app`
  - `/opt/ha-ai/state`
  - `/opt/ha-ai/backups`
- UFW rules (SSH + pgAdmin on `5050` + operator UI on `5080` for your LAN CIDR)
- helper commands:
  - `ha-ai-status`
  - `ha-ai-deploy`
  - `ha-ai-rollback`

## 5) Create and edit production env file

From VM:

```bash
cd /opt/ha-ai/app
cp .env.prod.example /opt/ha-ai/.env.prod
nano /opt/ha-ai/.env.prod
```

Set at least these keys:

```bash
IMAGE_REPO=ghcr.io/bob-laz/ha_ai_analyzer
IMAGE_TAG=sha-<commit>

HA_WS_URL=ws://<HAOS_VM_IP>:8123/api/websocket
HA_TOKEN=<your-long-lived-ha-token>
OPENAI_API_KEY=<your-openai-key>

POSTGRES_PASSWORD=<strong-password>
PGADMIN_DEFAULT_PASSWORD=<strong-password>
UI_BASIC_AUTH_USERNAME=operator
UI_BASIC_AUTH_PASSWORD=<strong-password>

AUTOMATION_SNAPSHOT_SCHEDULE_TIME=03:15
AUTOMATION_SNAPSHOT_INCLUDE_CONFIG=true
AUTOMATION_SNAPSHOT_INCLUDE_ENVIRONMENT_INVENTORY=true
HA_ENVIRONMENT_SNAPSHOTS_RETENTION_DAYS=60
LLM_MAX_ENVIRONMENT_ITEMS_PER_TYPE=50
LLM_MAX_RESOURCE_USAGE_ITEMS_PER_TYPE=20
LLM_HA_NOTIFICATION_ENABLED=true
LLM_HA_NOTIFICATION_TITLE=Home Assistant AI Analysis
LLM_HA_NOTIFICATION_ID=ha_ai_llm_analysis_latest

DAILY_SUMMARY_SCHEDULE_TIME=00:10
DAILY_SUMMARY_BASELINE_DAYS=7
DAILY_SUMMARY_MAX_RESOURCE_USAGE_ITEMS_PER_TYPE=5
DAILY_SUMMARY_NOTIFICATION_ENABLED=true
DAILY_SUMMARY_NOTIFICATION_TITLE=Daily Home Summary
DAILY_SUMMARY_NOTIFICATION_ID=ha_ai_daily_summary_latest

AUTOMATION_SNAPSHOT_INCLUDE_USAGE_SNAPSHOTS=true
HA_USAGE_SNAPSHOTS_RETENTION_DAYS=180
```

Notes:

- Use HAOS VM IP, not `.local`, for reliability.
- Keep secrets only in `/opt/ha-ai/.env.prod`.

## 6) (Optional) Authenticate Docker to GHCR once

If image pull fails later, run:

```bash
docker login ghcr.io
```

Use your GitHub username + PAT with package read access.

## 7) First deploy

From VM:

```bash
cd /opt/ha-ai/app
./ops/proxmox/deploy.sh --tag sha-<commit>
```

If successful, verify:

```bash
ha-ai-status
docker compose -f /opt/ha-ai/app/docker-compose.prod.yml --env-file /opt/ha-ai/.env.prod ps
docker compose -f /opt/ha-ai/app/docker-compose.prod.yml --env-file /opt/ha-ai/.env.prod logs -f collector retention automation-snapshots analytics daily-home-summary ui
```

Expected:

- services running
- collector logs show successful HA websocket auth/subscription
- UI loads on `http://<APP_VM_IP>:5080` and prompts for basic-auth credentials

## 8) Sanity-check data is flowing

From VM:

```bash
docker compose -f /opt/ha-ai/app/docker-compose.prod.yml --env-file /opt/ha-ai/.env.prod exec -T postgres \
  sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT now(), count(*) FROM events;"'
```

Run it again a minute later. `count(*)` should increase when HA activity occurs.

## 9) Updating to a newer release

When you have a new image tag:

```bash
cd /opt/ha-ai/app
./ops/proxmox/deploy.sh --tag sha-<new-commit>
```

For PR image testing:

```bash
cd /opt/ha-ai/app
./ops/proxmox/deploy.sh --tag pr-<number>-sha-<short-sha>
```

## 10) Rollback

Rollback to previous deployed tag:

```bash
cd /opt/ha-ai/app
./ops/proxmox/rollback.sh
```

Rollback to a specific tag:

```bash
cd /opt/ha-ai/app
./ops/proxmox/rollback.sh --tag sha-<older-commit>
```

## 11) Backups (recommended)

Create a backup now:

```bash
cd /opt/ha-ai/app
./ops/proxmox/backup-db.sh
```

Backups are written to `/opt/ha-ai/backups`.

Enable nightly backup timer:

```bash
sudo cp /opt/ha-ai/app/ops/proxmox/systemd/ha-ai-db-backup.service /etc/systemd/system/
sudo cp /opt/ha-ai/app/ops/proxmox/systemd/ha-ai-db-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ha-ai-db-backup.timer
sudo systemctl status ha-ai-db-backup.timer
```

## 12) Troubleshooting quick list

### Deploy says GHCR auth failed

Run `docker login ghcr.io`, then re-run deploy.

### Collector cannot connect to HA websocket

Check:
- `HA_WS_URL` is `ws://<HAOS_VM_IP>:8123/api/websocket`
- `HA_TOKEN` is valid
- app VM can reach `HAOS_VM_IP:8123`

### pgAdmin not reachable from laptop

Check:
- VM firewall allows `5050` from `LAN_CIDR`
- Proxmox firewall is not blocking
- service is running:
  - `docker compose -f /opt/ha-ai/app/docker-compose.prod.yml --env-file /opt/ha-ai/.env.prod ps pgadmin`

### UI not reachable from laptop

Check:
- VM firewall allows `5080` from `LAN_CIDR`
- `UI_PORT_BIND=5080` is set in `/opt/ha-ai/.env.prod`
- service is running:
  - `docker compose -f /opt/ha-ai/app/docker-compose.prod.yml --env-file /opt/ha-ai/.env.prod ps ui`

### Services unhealthy after update

Rollback immediately:

```bash
cd /opt/ha-ai/app
./ops/proxmox/rollback.sh
```

### Deploy fails with `network ... not found`

This usually means Docker has stale network references for older containers.
`deploy.sh` and `rollback.sh` now auto-recover by recreating the compose network and containers (without deleting volumes).
If you still see this after pulling latest scripts, run:

```bash
cd /opt/ha-ai/app
docker compose -f docker-compose.prod.yml --env-file /opt/ha-ai/.env.prod down --remove-orphans
./ops/proxmox/deploy.sh --tag <tag>
```

## Advanced/maintenance

Drift reconciliation (optional Ansible):

```bash
cd /opt/ha-ai/app/ops/proxmox
ansible-playbook -i <inventory> reconcile.yml
```
