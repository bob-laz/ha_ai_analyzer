# Onboarding Guide: Local Run Against LAN Home Assistant

This guide walks through a complete local setup using Docker Compose services in this repo and a real Home Assistant instance on your LAN.

## Goal

Run the collector locally so it ingests events from your existing Home Assistant over LAN into local Postgres, then optionally run one LLM analysis pass.

## 1. Prerequisites

- Docker Desktop installed and running
- Node.js 24
- Corepack enabled (`corepack enable`)
- Yarn 4 available through Corepack
- Bash 5+ (required by local helper scripts)

If you are on macOS, default `/bin/bash` (3.2) is too old. Install modern Bash:

```bash
brew install bash
```

Apple Silicon:

```bash
export PATH="/opt/homebrew/bin:$PATH"
```

Intel:

```bash
export PATH="/usr/local/bin:$PATH"
```

## 2. Clone and Install

```bash
git clone https://github.com/bob-laz/ha_ai_analyzer.git
cd ha_ai_analyzer
corepack enable
corepack install
yarn install
```

## 3. Create Home Assistant Long-Lived Token

In your Home Assistant UI:

1. Open your HA instance in browser (for example `http://homeassistant.local:8123`).
2. Go to your profile page.
3. Under Long-Lived Access Tokens, create a token.
4. Copy it now (you cannot view it again).

## 4. Configure Local Env

```bash
cp .env.example .env
```

Set these values in `.env` (recommended) or export in your shell:

```bash
HA_TOKEN=<your-long-lived-token>
HA_WS_URL=ws://homeassistant.local:8123/api/websocket
```

If `homeassistant.local` does not resolve from your machine, use your HA LAN IP:

```bash
HA_WS_URL=ws://192.168.x.y:8123/api/websocket
```

## 5. Start Local DB Services (Docker Compose)

```bash
yarn dev:db:up
```

This starts:

- Postgres on `localhost:5432`
- pgAdmin on `http://127.0.0.1:5050`
- (Later) retention scheduler starts automatically when collector starts

## 6. Start Collector in LAN Mode

```bash
yarn dev:collector --mode=lan
```

What this does:

- Ensures Postgres + pgAdmin are running via Docker Compose
- Loads repo-root `.env` before validating runtime config
- Connects collector to your LAN Home Assistant using `HA_WS_URL` + `HA_TOKEN`
- Runs collector on host for fast iteration

Leave this process running while testing.

## 7. Verify Ingestion

Option A: pgAdmin

- Open `http://127.0.0.1:5050`
- Login: `admin@example.com` / `admin`
- Server is pre-registered as `ha_ai_postgres`
- Run:

```sql
SELECT id, event_type, entity_id, context_id, event_time, received_at
FROM events
ORDER BY received_at DESC
LIMIT 20;
```

Option B: psql in container

```bash
docker exec -it ha_ai_postgres psql -U ha_ai -d ha_ai -c "SELECT event_type, entity_id, received_at FROM events ORDER BY received_at DESC LIMIT 20;"
```

## 8. Optional: Run One LLM Analysis Pass

In a new terminal:

```bash
export OPENAI_API_KEY='<your-openai-key>'
yarn start:analysis:once
```

This writes analysis artifacts into:

- `agent_runs`
- `insights`
- `evidence`
- `recommendations`
- `analysis_results`

## 9. Stop Local Services

Stop collector with `Ctrl+C`, then tear down local Docker services:

```bash
yarn dev:down
```

## Troubleshooting

- `HA_TOKEN is required`:
  confirm token is set in shell or `.env` and rerun.
- Repeated `collector connection dropped`:
  token is invalid/expired or HA websocket URL is wrong.
- `homeassistant.local` does not resolve:
  switch to explicit LAN IP in `HA_WS_URL`.
- `docker compose ... network ... not found`:
  rerun `yarn dev:db:up`; local script self-heals stale pgAdmin references.
- `docker compose down -v` leaves network in use:
  use `yarn dev:down` (includes repo profiles).
