# @ha-ai/tools

Analytics and LLM analysis package for Home Assistant event data.

## Responsibilities

- Provide stable query tool interfaces:
  - `getDailySummary`
  - `getTopChanges`
  - `traceContext`
  - `entityTimeline`
  - `correlate`
  - `getAutomationSnapshot`
  - `listAutomations`
  - `publishReport`
- Run LLM analysis over rolling windows and persist normalized artifacts.
- Support manual and scheduled analysis execution.

## Package Layout

- `src/interfaces.ts`: exported tool interface surface (implemented + stubs)
- `src/agentTools.ts`: SQL-backed query tool implementations
- `src/analysisRunner.ts`: end-to-end orchestration
- `src/analysisRepo.ts`: persistence layer for `agent_runs/insights/evidence/recommendations`
- `src/analyticsJob.ts`: runtime entrypoint (`--once` and `--schedule`)
- `src/llm/`: provider abstraction, prompt builder, output normalization, OpenAI provider

## Local Commands

Run from repo root:

```bash
yarn workspace @ha-ai/tools build
yarn workspace @ha-ai/tools lint:type
yarn workspace @ha-ai/tools test
yarn workspace @ha-ai/tools start:analytics --once
yarn workspace @ha-ai/tools start:analytics --schedule
yarn workspace @ha-ai/tools start:retention --once
yarn workspace @ha-ai/tools start:retention --schedule
```

Root aliases:

```bash
yarn start:analysis:once
yarn start:analysis:scheduler
yarn start:retention --once
```

For host-run local development, `yarn dev:collector -- --mode=...` auto-starts retention scheduler by default.

## Runtime Environment

- `DATABASE_URL` default `postgresql://ha_ai:ha_ai_dev_password@localhost:5432/ha_ai`
- `REPORT_OUTPUT_DIR` default `/tmp/ha-ai-reports`
- `ANALYTICS_TIMEZONE` default `UTC`

LLM settings:

- `OPENAI_API_KEY` required for `LLM_PROVIDER=openai`
- `LLM_PROVIDER` default `openai`
- `LLM_MODEL` default `gpt-4.1-mini`
- `LLM_ANALYSIS_WINDOW_HOURS` default `24`
- `LLM_ANALYSIS_MAX_INSIGHTS` default `5`
- `LLM_MAX_TOP_CHANGES` default `20`
- `LLM_MAX_TRACE_CONTEXTS` default `10`
- `LLM_MAX_EVENTS_PER_CONTEXT` default `60`
- `LLM_TRACE_MAX_DEPTH` default `6`
- `LLM_REQUEST_TIMEOUT_MS` default `30000`
- `LLM_RETRY_MAX_ATTEMPTS` default `3`

Scheduler settings:

- `LLM_SCHEDULE_TIME` default `03:00` (24h, `HH:MM`)
- `LLM_SCHEDULE_TIMEZONE` default `ANALYTICS_TIMEZONE` or `UTC`

Retention settings:

- `RETENTION_SCHEDULE_TIME` default `03:30`
- `RETENTION_SCHEDULE_TIMEZONE` default `ANALYTICS_TIMEZONE` or `UTC`
- `EVENTS_RETENTION_DAYS` default `14`
- `EVENTS_PARTITION_LOOKBACK_DAYS` default `2`
- `EVENTS_PARTITION_PRECREATE_DAYS` default `14`
- `TRACE_CONTEXTS_RETENTION_DAYS` default `30`
- `ENTITY_SNAPSHOTS_RETENTION_DAYS` default `30`
- `AUTOMATION_SNAPSHOTS_RETENTION_DAYS` default `60`
- `AGENT_RUNS_RETENTION_DAYS` default `180`
- `ORPHAN_ANALYSIS_RESULTS_RETENTION_DAYS` default `180`
- `RETENTION_BATCH_SIZE` default `50000`

## Output and Persistence

A successful run writes:

- `agent_runs` lifecycle row (`running` -> `completed`)
- ranked `insights`
- linked `evidence`
- `recommendations` with `status='proposed'`
- final report row in `analysis_results` via `publishReport`

Recommendations are propose-only and are never auto-applied.

## Testing

Run all package tests:

```bash
yarn workspace @ha-ai/tools test
```

DB-backed integration tests run when `TEST_DATABASE_URL` is set:

```bash
yarn dev:db:up
TEST_DATABASE_URL=postgresql://ha_ai:ha_ai_dev_password@localhost:5432/ha_ai yarn workspace @ha-ai/tools test
```
