# Proxmox Deployment Guide (Debian 13 VM)

This guide deploys `ha_ai_analyzer` to a Debian 13 VM in Proxmox with Docker Compose and GHCR images.

## Deployment model

- CI publishes image tags to GHCR on `main` after CI succeeds.
- VM deploy is semi-automatic: you run one command with the desired tag.
- Runtime services:
  - `postgres`
  - `collector`
  - `retention`
  - `analytics`
  - `pgadmin` (LAN-exposed)

## 1) One-time Proxmox VM bootstrap (Debian 13)

Create a dedicated Debian 13 VM for this stack before any app deploy steps.

Recommended VM baseline:

- 2 vCPU minimum (4 preferred if running analytics scheduler continuously)
- 4 GB RAM minimum (8 GB preferred)
- 40+ GB disk
- VirtIO NIC attached to your LAN bridge (example: `vmbr0`)
- Static DHCP lease or static IP reservation

Initial OS bootstrap (inside Debian VM):

```bash
sudo apt-get update
sudo apt-get upgrade -y
sudo apt-get install -y qemu-guest-agent curl ca-certificates
sudo systemctl enable --now qemu-guest-agent
```

Optional but recommended:

- Create a dedicated non-root deploy user with SSH keys.
- Disable password SSH login after key-based access is working.
- Confirm VM clock/timezone is correct.

## 2) VM prerequisites

- Proxmox VM running Debian 13.
- Outbound network access to:
  - `github.com`
  - `ghcr.io`
- LAN access to your Home Assistant instance.

## 3) Ensure network reachability to HAOS VM (same Proxmox host)

If Home Assistant OS runs in a separate VM on the same Proxmox node, verify network path before deploying:

1. Ensure both VMs are connected to reachable bridges/VLANs.
2. Ensure Proxmox firewall (Datacenter/Node/VM levels) allows Debian VM -> HAOS VM TCP `8123`.
3. Prefer HAOS VM IP in production `HA_WS_URL` over `.local` mDNS.

Example checks from Debian app VM:

```bash
# Replace with your HAOS VM IP
HAOS_IP=192.168.1.50

ping -c 3 "$HAOS_IP"
curl -I --max-time 5 "http://${HAOS_IP}:8123/"
```

Expected result:

- Ping succeeds (or ICMP intentionally blocked but TCP check succeeds).
- HTTP check returns 200/302/401/403 instead of timeout/refused.

If these fail, fix bridge/VLAN/firewall routing before continuing.

## 4) Bootstrap VM host

From your local machine, copy repo to VM once (example path `/opt/ha-ai/app`) and run bootstrap as root:

```bash
cd /opt/ha-ai/app
sudo APP_OWNER=<vm-user> LAN_CIDR=192.168.0.0/16 ./ops/proxmox/bootstrap.sh
```

What bootstrap does:

- installs Docker Engine + Compose plugin
- creates `/opt/ha-ai/app`, `/opt/ha-ai/state`, `/opt/ha-ai/backups`
- configures UFW to allow SSH and LAN access to pgAdmin on `5050`
- installs helper commands:
  - `ha-ai-deploy`
  - `ha-ai-rollback`
  - `ha-ai-status`

## 5) Configure production env

Create env file from template:

```bash
cd /opt/ha-ai/app
cp .env.prod.example /opt/ha-ai/.env.prod
```

Update required values in `/opt/ha-ai/.env.prod`:

- `IMAGE_REPO` (default `ghcr.io/bob-laz/ha_ai_analyzer`)
- `IMAGE_TAG` (initially set to a CI-published `sha-...` tag)
- `HA_WS_URL` (prefer `ws://<haos-vm-ip>:8123/api/websocket`)
- `HA_TOKEN`
- `OPENAI_API_KEY`
- `POSTGRES_PASSWORD`
- `PGADMIN_DEFAULT_PASSWORD`

Optional GHCR auth for deploy preflight:

- set `GHCR_USERNAME` and `GHCR_TOKEN` in shell before deploy, or
- run `docker login ghcr.io` once on the VM.

## 6) Initial deploy

Use a tag from the `Publish Image` GitHub workflow summary:

```bash
cd /opt/ha-ai/app
./ops/proxmox/deploy.sh --tag sha-<commit>
```

Check status:

```bash
ha-ai-status
```

Tail logs:

```bash
docker compose -f /opt/ha-ai/app/docker-compose.prod.yml --env-file /opt/ha-ai/.env.prod logs -f collector retention analytics
```

## 7) Updating to a new release

1. Merge to `main`.
2. Wait for `CI` then `Publish Image` workflows to complete.
3. Copy the `sha-...` tag from workflow summary.
4. Run:

```bash
cd /opt/ha-ai/app
./ops/proxmox/deploy.sh --tag sha-<new-commit>
```

The deploy script:

- validates Docker/Compose and env files
- validates GHCR auth availability
- updates `IMAGE_TAG` in `/opt/ha-ai/.env.prod`
- pulls images and restarts services
- verifies running/healthy states
- records `current_tag` and `previous_tag` in `/opt/ha-ai/state`

## 8) Rollback

Rollback to previous deployment:

```bash
cd /opt/ha-ai/app
./ops/proxmox/rollback.sh
```

Rollback to explicit tag:

```bash
cd /opt/ha-ai/app
./ops/proxmox/rollback.sh --tag sha-<older-commit>
```

## 9) Backups

Manual DB backup:

```bash
cd /opt/ha-ai/app
./ops/proxmox/backup-db.sh
```

Backups are stored in `/opt/ha-ai/backups` as `ha_ai_<timestamp>.dump`.

### Enable nightly backup timer

```bash
sudo cp /opt/ha-ai/app/ops/proxmox/systemd/ha-ai-db-backup.service /etc/systemd/system/
sudo cp /opt/ha-ai/app/ops/proxmox/systemd/ha-ai-db-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ha-ai-db-backup.timer
sudo systemctl status ha-ai-db-backup.timer
```

## 10) Restore drill (recommended)

Example restore into running postgres container:

```bash
LATEST_BACKUP="$(ls -1t /opt/ha-ai/backups/ha_ai_*.dump | head -n1)"
docker compose -f /opt/ha-ai/app/docker-compose.prod.yml --env-file /opt/ha-ai/.env.prod exec -T postgres dropdb -U "$POSTGRES_USER" --if-exists "$POSTGRES_DB"
docker compose -f /opt/ha-ai/app/docker-compose.prod.yml --env-file /opt/ha-ai/.env.prod exec -T postgres createdb -U "$POSTGRES_USER" "$POSTGRES_DB"
docker compose -f /opt/ha-ai/app/docker-compose.prod.yml --env-file /opt/ha-ai/.env.prod exec -T postgres pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" < "$LATEST_BACKUP"
```

## 11) pgAdmin hardening notes

pgAdmin is LAN-exposed by design in this deployment.

- Use a strong `PGADMIN_DEFAULT_PASSWORD`.
- Keep UFW enabled and limit access to your LAN CIDR only.
- Do not expose port `5050` to WAN/NAT.

## 12) Drift management

Use periodic reconcile runs to keep host configuration consistent:

```bash
cd /opt/ha-ai/app/ops/proxmox
ansible-playbook -i <inventory> reconcile.yml
```

This re-runs the idempotent bootstrap baseline.
