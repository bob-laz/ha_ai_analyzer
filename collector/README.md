# @ha-ai/collector

Home Assistant websocket ingestion service.

## Responsibilities

- Connect to Home Assistant websocket API with token auth.
- Subscribe to configured event types.
- Normalize/filter events before writes.
- Batch writes into Postgres with idempotent upsert via `dedupe_key`.
- Handle reconnects, backpressure, and graceful shutdown flush.

## Package Layout

- `src/main.ts`: process entrypoint
- `src/haClient.ts`: websocket protocol/auth/subscription
- `src/normalize.ts`: event normalization
- `src/filters.ts`: domain allowlist/excludelist filtering
- `src/db.ts`: batched write path
- `src/config.ts`: environment config loading

## Local Commands

Run from repo root:

```bash
yarn workspace @ha-ai/collector build
yarn workspace @ha-ai/collector lint:type
yarn workspace @ha-ai/collector test
yarn workspace @ha-ai/collector start:collector
```

Common local-dev command (host collector + local stack helpers):

```bash
yarn dev:collector --mode=lan
yarn dev:collector --mode=dev-ha
```

`yarn dev:collector` auto-loads repo-root `.env` values when that file exists.
`yarn dev:collector` also auto-starts the retention scheduler unless `RETENTION_AUTOSTART=false`.

## Required Environment

- `HA_TOKEN`: Home Assistant long-lived token (required)

## Common Environment

- `DATABASE_URL` default `postgresql://ha_ai:ha_ai_dev_password@localhost:5432/ha_ai`
- `HA_WS_URL` default `ws://localhost:8123/api/websocket`
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
- `COLLECTOR_INSTANCE_ID` default host name
- `LOG_LEVEL` default `info`

See repo root `/Users/bob/code/homeassistant/ha_ai_analyzer/.env.example` for full local-dev helper envs.

## Testing

- Unit/protocol tests run with `yarn workspace @ha-ai/collector test`.
- DB-backed integration test skips when `TEST_DATABASE_URL` is unset.
- For DB-backed run:

```bash
yarn dev:db:up
TEST_DATABASE_URL=postgresql://ha_ai:ha_ai_dev_password@localhost:5432/ha_ai yarn workspace @ha-ai/collector test
```
