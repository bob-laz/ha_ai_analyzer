# Home Assistant AI Analyzer

## Project Layout

- `/collector` - Home Assistant WebSocket collector service (TypeScript)
- `/schema` - Postgres schema bootstrap (single baseline script)
- `/tools` - analytics/query tools and scheduled analytics job
- `/docker-compose.yml` - local stack (postgres, collector, analytics profile, dev-ha profile, pgadmin profile)
- `/docs/architecture.md` - runtime architecture and flow
- `/docs/data-contracts.md` - table + tool output contracts
- `/docs/capability-matrix.md` - implemented vs stubbed tool coverage

## Runtime

- Node.js 24
- Yarn 4 workspaces (root-managed monorepo)
- Bash 5+ for local helper scripts (`scripts/*.sh`)
- Docker Compose database image: `postgres:18`
- Local dev Home Assistant image: `ghcr.io/home-assistant/home-assistant:2026.2.2` (pinned)
- Biome 2 for linting/formatting

## Quick Start

1. Export a long-lived Home Assistant token:

```bash
export HA_TOKEN='<your-ha-long-lived-token>'
```

2. Install workspace dependencies from repo root:

```bash
yarn install
```

3. Copy environment template and adjust local values:

```bash
cp .env.example .env
```

4. Start services:

```bash
docker compose up --build
```

5. Optional services:

```bash
docker compose --profile debug up -d pgadmin
docker compose --profile analytics up -d analytics
docker compose --profile dev-ha up -d homeassistant
```

## Workspace Commands

From `/Users/bob/code/homeassistant/ha_ai_analyzer`:

```bash
yarn build
yarn test
yarn verify
yarn lint
yarn format
yarn lint:type
yarn biome migrate --write # only needed when Biome major version changes
yarn start:collector
yarn start:analytics
yarn dev:db:up
yarn dev:down
yarn dev:collector -- --mode=lan
yarn dev:collector -- --mode=dev-ha
yarn dev:collector -- --mode=dev-ha --with-demo-events
yarn dev:ha:up
yarn dev:ha:logs
yarn dev:ha:emit-demo
```

## Dependency Policy

- Direct dependencies should track latest stable versions unless intentionally pinned for a stated reason.
- To upgrade all workspace dependencies:

```bash
yarn up '*' '@*/*'
yarn
```

## Collector Environment Variables

Numeric collector env vars use documented defaults when unset or blank.

- `DATABASE_URL` default `postgresql://ha_ai:ha_ai_dev_password@localhost:5432/ha_ai`
- `HA_WS_URL` default `ws://localhost:8123/api/websocket`
- `HA_TOKEN` required
- `EVENT_TYPES` default `state_changed,call_service`
- `DOMAIN_ALLOWLIST` default empty
- `DOMAIN_EXCLUDELIST` default empty
- `BATCH_SIZE` default `250`
- `FLUSH_INTERVAL_SECONDS` default `2`
- `RECONNECT_INITIAL_SECONDS` default `1`
- `RECONNECT_MAX_SECONDS` default `30`
- `RECONNECT_JITTER_RATIO` default `0.2`
- `MAX_BUFFERED_EVENTS` default `5000`
- `OVERFLOW_POLICY` default `drop_newest` (`drop_newest`, `drop_oldest`, `retry`)
- `RETRY_BACKPRESSURE_DELAY_MS` default `250`
- `COLLECTOR_INSTANCE_ID` default hostname
- `DEV_HA_HTTP_URL` default `http://127.0.0.1:8123` (local dev helper)
- `DEV_HA_WS_URL` default `ws://127.0.0.1:8123/api/websocket` (local dev helper)
- `DEV_HA_DEMO_INTERVAL_SECONDS` default `10` (local dev helper)
- `DEV_HA_AUTO_BOOTSTRAP` default `true` (auto-create local dev owner + token when needed)
- `DEV_HA_TOKEN_FILE` default `.dev-ha.token` (cached local dev HA token file)
- `DEV_HA_OWNER_NAME` default `HA AI Dev`
- `DEV_HA_OWNER_USERNAME` default `ha_ai_dev`
- `DEV_HA_OWNER_PASSWORD` default `ha_ai_dev_password`
- `DEV_HA_OWNER_LANGUAGE` default `en`
- `DEV_HA_CLIENT_ID` default `http://127.0.0.1:8123/` (HA auth client id)
- `DEV_HA_REDIRECT_URI` default `http://127.0.0.1:8123/auth/external/callback` (HA auth redirect uri)
- `DEV_HA_TOKEN_CLIENT_NAME` default `ha-ai-collector-dev`
- `DEV_HA_TOKEN_LIFESPAN_DAYS` default `3650`

## Local Collector Development Modes

The default local dev topology runs Postgres and optional Home Assistant in Docker, while running collector on the host process for fast iteration.

`yarn dev:collector --mode=...` also starts `pgadmin` automatically for DB inspection:
- URL: `http://127.0.0.1:5050`
- Default login: `admin@example.com` / `admin`
- Pre-registered server: `ha_ai_postgres` (host `postgres`, db `ha_ai`, user `ha_ai`)
- Database password: `ha_ai_dev_password`

To start only database services (no collector, no Home Assistant):

```bash
yarn dev:db:up
```

To tear down all local services and volumes (including `debug`, `dev-ha`, and `analytics` profiles):

```bash
yarn dev:down
```

### Mode A: LAN Home Assistant

Use this when pointing collector to a real Home Assistant instance on your network:

```bash
export HA_TOKEN='<your-ha-long-lived-token>'
export HA_WS_URL='ws://homeassistant.local:8123/api/websocket' # optional override
yarn dev:collector --mode=lan
```

### Mode B: Local Development Home Assistant

Use this when running a local bare-bones Home Assistant container:

```bash
yarn dev:collector --mode=dev-ha
```

Default behavior in `dev-ha` mode:

1. Starts Home Assistant container.
2. Waits for HTTP readiness.
3. If `HA_TOKEN` is unset, tries to load token from `.dev-ha.token`.
4. If still missing and `DEV_HA_AUTO_BOOTSTRAP=true`, auto-creates/uses dev owner credentials and generates a long-lived token.
5. Caches generated token in `.dev-ha.token` for subsequent runs.

You can still force manual token usage by setting `HA_TOKEN` directly.

### Optional Demo Event Generation

For quick collector smoke testing in `dev-ha` mode:

```bash
yarn dev:collector --mode=dev-ha --with-demo-events
```

Or run only the emitter helper:

```bash
yarn dev:ha:emit-demo
```

### Troubleshooting

- `docker is required` / `'docker compose' is required`:
  install Docker Desktop and ensure daemon is running.
- `bad substitution` from local scripts on macOS:
  default macOS Bash (`3.2`) is too old for this repo scripts.
  install modern Bash with Homebrew and ensure it is first in `PATH`:

```bash
brew install bash
# Apple Silicon:
export PATH="/opt/homebrew/bin:$PATH"
# Intel:
export PATH="/usr/local/bin:$PATH"
bash --version
```
- `pgadmin` not reachable on `http://127.0.0.1:5050`:
  run `docker compose --profile debug logs pgadmin` and ensure port `5050` is free.
- `pgadmin` opens but no servers are listed:
  rerun `yarn dev:db:up` to restart/import `pgadmin/servers.json`.
- `there is no unique or exclusion constraint matching the ON CONFLICT specification`:
  your local DB likely predates the updated baseline schema.
  recreate local volumes so `schema/001_init.sql` is applied on fresh init:

```bash
yarn dev:down
yarn dev:db:up
```
- `curl ... 401` from demo emitter or repeated `collector connection dropped` right after startup:
  the cached `.dev-ha.token` is stale for the current Home Assistant volume.
  the dev runner now auto-removes stale cached tokens and re-bootstraps.
  if HA rejects long-lived token creation, bootstrap falls back to a short-lived access token for the current run.
  if you exported `HA_TOKEN` manually, unset it so bootstrap can run:

```bash
unset HA_TOKEN
yarn dev:collector --mode=dev-ha --with-demo-events
```
- `docker compose down -v` reports `Network ... Resource is still in use`:
  use `yarn dev:down` so profile services are included in teardown.
- `HA_TOKEN is required`:
  in `dev-ha` mode this means auto-bootstrap could not authenticate with configured dev credentials.
  either update `DEV_HA_OWNER_USERNAME`/`DEV_HA_OWNER_PASSWORD` or set `HA_TOKEN` manually.
- `Home Assistant did not become ready in time`:
  first startup can take several minutes; onboarding redirects are considered healthy by the dev script.
  if startup still fails, inspect logs:

```bash
yarn dev:ha:logs
```

## Schema

- `schema/001_init.sql` baseline tables, ingest idempotency columns, and indexes

## Local Validation Runbook

1. Start DB only:

```bash
yarn dev:db:up
```

2. Run collector locally:

```bash
yarn workspace @ha-ai/collector start:collector
```

3. Smoke-check ingest:

```sql
SELECT event_type, entity_id, context_id, collector_instance, received_at
FROM events
ORDER BY received_at DESC
LIMIT 20;
```

4. Smoke-check tool queries (daily summary):

```bash
yarn workspace @ha-ai/tools start:analytics
```

## Testing

Integration tests require `TEST_DATABASE_URL`; they skip when it is not set.

```bash
TEST_DATABASE_URL=postgresql://ha_ai:ha_ai_dev_password@localhost:5432/ha_ai yarn test
```

Golden output fixtures for tool contracts are stored in `tools/tests/fixtures/` and validated by `tools/tests/goldenOutputs.test.ts`.

Integration helper scripts (starts `postgres` via Docker Compose, waits for health, sets `TEST_DATABASE_URL` if unset):

```bash
yarn test:integration
yarn test:integration:collector
yarn test:integration:tools
```

## CI

GitHub Actions workflow `.github/workflows/ci.yml` runs on push to `main` and pull requests:

- `verify` job runs `yarn verify`.
- `integration-tests` job starts `postgres:18`, sets `TEST_DATABASE_URL`, and runs `yarn test` so DB-backed integration suites execute.
- CI enables Corepack and runs `corepack install`, which activates the package manager/version declared in `package.json` (`packageManager`).

## Dependency Automation

Dependabot configuration lives in `.github/dependabot.yml` and runs weekly for:

- Yarn/npm workspace dependencies (`package-ecosystem: npm`, repo root)
- GitHub Actions workflow dependencies
- Docker Compose image tags in `docker-compose.yml`
- Docker base images in `collector/Dockerfile`

Auto-merge policy is in `.github/workflows/dependabot-automerge.yml`:

- only Dependabot PRs are considered
- only patch/minor version updates are auto-merged
- merge method is `squash`
- auto-merge still respects required status checks (CI must pass)

## Current Non-goals

- Full implementation of non-priority tool functions (`entityTimeline`, `correlate`, `getAutomationSnapshot`, `listAutomations`)
- Production-grade secret management and external report delivery integrations
