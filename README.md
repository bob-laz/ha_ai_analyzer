# Home Assistant AI Analyzer

## Project Layout

- `/collector` - Home Assistant WebSocket collector service (TypeScript)
- `/schema` - Postgres schema bootstrap (single baseline script)
- `/tools` - analytics/query tools and scheduled analytics job
- `/docker-compose.yml` - local stack (postgres, collector, analytics profile, pgadmin profile)
- `/docs/architecture.md` - runtime architecture and flow
- `/docs/data-contracts.md` - table + tool output contracts
- `/docs/capability-matrix.md` - implemented vs stubbed tool coverage

## Runtime

- Node.js 24
- Yarn 4 workspaces (root-managed monorepo)
- Docker Compose database image: `postgres:18`
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
```

## Dependency Policy

- Direct dependencies should track latest stable versions unless intentionally pinned for a stated reason.
- To upgrade all workspace dependencies:

```bash
yarn up '*' '@*/*'
yarn
```

## Collector Environment Variables

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

## Schema

- `schema/001_init.sql` baseline tables, ingest idempotency columns, and indexes

## Local Validation Runbook

1. Start DB only:

```bash
docker compose up -d postgres
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
