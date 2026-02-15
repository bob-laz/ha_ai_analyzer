# Architecture

## Goals
- Collect Home Assistant telemetry from `/api/websocket`
- Persist normalized events in Postgres
- Expose query tools for exploratory AI analytics
- Publish summarized analysis artifacts

## Components
- `collector` package:
  - Connects/authenticates to Home Assistant websocket
  - Subscribes to configured event types
  - Normalizes and filters events
  - Buffers and batch-inserts into Postgres
  - Reconnects with exponential backoff + jitter
- `postgres`:
  - Stores events, snapshots, trace contexts, and analysis artifacts
- `tools` package:
  - Query functions for daily summaries, top changes, and trace context traversal
  - Report publication to `analysis_results`
  - Scheduled analytics entrypoint

## Data Flow
1. Home Assistant sends websocket frames (`auth_required`, `result`, `event`, heartbeat).
2. `collector` authenticates and subscribes.
3. Event frames are normalized to canonical shape and domain-filtered.
4. Writer buffers accepted events and flushes batches into `events`.
5. `tools` query persisted data and emit structured outputs for agents.
6. Analytics job writes report artifacts and publishes records to Postgres.

## Reliability Controls
- Ack correlation by websocket message `id`
- Malformed message quarantine logging
- Backpressure policies (`drop_newest`, `drop_oldest`, `retry`)
- Shutdown flush to avoid buffered event loss
- Idempotency via `events.dedupe_key`

## Package Boundaries
- Root workspace orchestrates build/lint/test.
- `collector` owns ingestion runtime + ingestion tests.
- `tools` owns query/report layer + tool tests.
