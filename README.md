# Home Assistant AI Analyzer

Monorepo for collecting Home Assistant events into Postgres and generating analysis artifacts from that data.

## Overview

This project has two runtime components:

- Collector (`@ha-ai/collector`): subscribes to Home Assistant websocket events and ingests normalized records into Postgres.
- Tools (`@ha-ai/tools`): provides query tools (summary, top changes, context tracing, timelines, correlations, automation snapshots/listing) and an LLM analysis job that writes `agent_runs`, `insights`, `evidence`, `recommendations`, and `analysis_results`.

Collector ingest defaults include noise suppression for Home Assistant event spam:
- drop `state_changed` records where `old_state.state` equals `new_state.state`
- keep `binary_sensor` motion records only for `off -> on` transitions
- enrich `call_service.entity_id` from `service_data.device_id` / `target.device_id` using HA entity registry mappings when direct `entity_id` is missing

## Repository Layout

- `collector/` collector package
- `tools/` analytics and LLM package
- `schema/` baseline SQL bootstrap (`001_init.sql`)
- `scripts/` local development scripts
- `docker-compose.yml` local containers and profiles
- `docker-compose.prod.yml` Proxmox production stack
- `ops/proxmox/` bootstrap/deploy/rollback/backup automation
- `docs/architecture.md` runtime architecture
- `docs/data-contracts.md` table and tool contracts
- `docs/capability-matrix.md` implemented vs stubbed tools

## Package Documentation

For package-specific commands, environment variables, and troubleshooting:

- `collector/README.md`
- `tools/README.md`

## Onboarding Guides

- LAN Home Assistant onboarding: `docs/onboarding-lan.md`
- Proxmox production deployment: `docs/deploy-proxmox.md`

## Runtime Prerequisites

- Node.js 24
- Yarn 4 (via Corepack)
- Docker + Docker Compose
- Bash 5+ for local helper scripts in `scripts/`

## Quick Start (Project Level)

1. Install dependencies:

```bash
yarn install
```

2. Create local env file:

```bash
cp .env.example .env
```

`yarn dev:collector` reads values from repo-root `.env` automatically.

3. Start local DB services:

```bash
yarn dev:db:up
```

Retention scheduler starts automatically when `yarn dev:collector` starts.
pgAdmin defaults come from `.env` (`PGADMIN_DEFAULT_EMAIL`, `PGADMIN_DEFAULT_PASSWORD`) and the registered `ha_ai_postgres` server reuses your configured DB password.

4. Run collector locally (choose mode):

```bash
yarn dev:collector --mode=lan
# or
yarn dev:collector --mode=dev-ha
```

5. Run one analysis pass:

```bash
OPENAI_API_KEY='<token>' yarn start:analysis:once
```

## Root Commands

From `/Users/bob/code/homeassistant/ha_ai_analyzer`:

```bash
yarn build
yarn test
yarn verify
yarn lint
yarn format
yarn lint:type
yarn test:integration
yarn test:integration:collector
yarn test:integration:tools
yarn dev:db:up
yarn dev:down
yarn dev:collector --mode=lan
yarn dev:collector --mode=dev-ha
yarn start:collector
yarn start:analytics
yarn start:retention --once
yarn start:analysis:once
yarn start:analysis:scheduler
```

## CI and Dependency Automation

- CI workflow: `.github/workflows/ci.yml`
  - `verify` job runs `yarn verify`
  - `verify` job also validates `collector/Dockerfile` by building the image
  - `integration-tests` runs DB-backed suites with Postgres 18
  - `publish-pr-image` publishes PR test images to GHCR with tags `pr-<number>-sha-<sha>` (same-repo PRs only)
- Dependabot config: `.github/dependabot.yml`
- Dependabot auto-merge workflow: `.github/workflows/dependabot-automerge.yml`

## Local Data Lifecycle

- Bring up local services: `yarn dev:db:up`
- Tear down local services and volumes across active profiles: `yarn dev:down`
- Baseline schema is applied from `schema/001_init.sql` on fresh Postgres volume initialization.

## Production Deployment (Proxmox Debian 13 VM)

- Production compose file: `/Users/bob/code/homeassistant/ha_ai_analyzer/docker-compose.prod.yml`
- Production env template: `/Users/bob/code/homeassistant/ha_ai_analyzer/.env.prod.example`
- VM operations scripts: `/Users/bob/code/homeassistant/ha_ai_analyzer/ops/proxmox/`
  - `/Users/bob/code/homeassistant/ha_ai_analyzer/ops/proxmox/bootstrap.sh`
  - `/Users/bob/code/homeassistant/ha_ai_analyzer/ops/proxmox/deploy.sh`
  - `/Users/bob/code/homeassistant/ha_ai_analyzer/ops/proxmox/rollback.sh`
  - `/Users/bob/code/homeassistant/ha_ai_analyzer/ops/proxmox/backup-db.sh`
- CI image publish workflow: `/Users/bob/code/homeassistant/ha_ai_analyzer/.github/workflows/publish-image.yml`

See `/Users/bob/code/homeassistant/ha_ai_analyzer/docs/deploy-proxmox.md` for full setup, update, rollback, and backup instructions.
