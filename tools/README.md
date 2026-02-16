# @ha-ai/tools

Analytics and LLM analysis package for Home Assistant event data.

## Architecture

```mermaid
flowchart TB
  HA["Home Assistant HTTP API"]
  LLM["OpenAI API"]
  PG["Postgres"]

  subgraph QueryLayer["Query + Persistence Layer"]
    Q["agentTools.ts<br/>summary/top-changes/trace/timeline/correlate"]
    PR["publishReport()"]
    REPO["analysisRepo.ts"]
  end

  subgraph Analysis["LLM Analysis Path"]
    AJ["analyticsJob.ts"]
    AR["analysisRunner.ts"]
    PB["llm/promptBuilder.ts"]
    OP["llm/openaiProvider.ts"]
    ON["llm/outputNormalizer.ts"]
  end

  subgraph Jobs["Non-LLM Scheduled Jobs"]
    ASJ["automationSnapshotJob.ts"]
    DLY["dailyHomeSummaryJob.ts"]
    RTN["retentionJob.ts"]
  end

  PG --> Q
  Q --> AR
  AR --> PB
  PB --> OP
  OP -->|"chat completion"| LLM
  LLM --> OP
  OP --> ON
  ON --> AR
  AR --> REPO
  AR --> PR
  REPO --> PG
  PR --> PG

  ASJ -->|"automation snapshots"| PG
  ASJ -->|"environment snapshots"| PG
  ASJ -->|"usage snapshots"| PG
  DLY --> Q
  DLY --> PR
  RTN -->|"TTL + partition maintenance"| PG

  AJ -->|"persistent_notification.create"| HA
  DLY -->|"persistent_notification.create"| HA
```

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
- Publish a human-readable Home Assistant persistent notification for each successful analysis run (configurable).
- Run a separate daily-home-summary agent that compares the day against recent baseline days and notifies Home Assistant.
- Sync Home Assistant rule context snapshots (`automation`, `script`, `scene`, blueprint references/metadata) into `automation_snapshots`.
- Sync Home Assistant environment inventory (`device`, `service`, `integration`, `addon`) into `ha_environment_snapshots`.
- Sync Home Assistant utility usage snapshots (`energy`, `water`, `gas`, `power`) into `ha_usage_snapshots`.
- Support manual and scheduled analysis execution.

## Package Layout

- `src/interfaces.ts`: exported tool interface surface (implemented + stubs)
- `src/agentTools.ts`: SQL-backed query tool implementations
- `src/analysisRunner.ts`: end-to-end orchestration
- `src/analysisRepo.ts`: persistence layer for `agent_runs/insights/evidence/recommendations`
- `src/analyticsJob.ts`: runtime entrypoint (`--once` and `--schedule`)
- `src/automationSnapshotJob.ts`: runtime entrypoint for rule-context snapshot sync
- `src/llm/`: provider abstraction, prompt builder, output normalization, OpenAI provider

## Local Commands

Run from repo root:

```bash
yarn workspace @ha-ai/tools build
yarn workspace @ha-ai/tools lint:type
yarn workspace @ha-ai/tools test
yarn workspace @ha-ai/tools start:analytics --once
yarn workspace @ha-ai/tools start:analytics --schedule
yarn workspace @ha-ai/tools start:automation-snapshots --once
yarn workspace @ha-ai/tools start:automation-snapshots --schedule
yarn workspace @ha-ai/tools start:daily-home-summary --once
yarn workspace @ha-ai/tools start:daily-home-summary --schedule
yarn workspace @ha-ai/tools start:retention --once
yarn workspace @ha-ai/tools start:retention --schedule
```

Root aliases:

```bash
yarn start:analysis:once
yarn start:analysis:scheduler
yarn start:automation-snapshots:once
yarn start:automation-snapshots:scheduler
yarn start:daily-home-summary:once
yarn start:daily-home-summary:scheduler
yarn start:retention --once
```

For host-run local development, `yarn dev:collector -- --mode=...` auto-starts retention, automation snapshot, and daily summary schedulers by default.

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
- `LLM_MAX_ENVIRONMENT_ITEMS_PER_TYPE` default `50`
- `LLM_MAX_RESOURCE_USAGE_ITEMS_PER_TYPE` default `20`
- `LLM_HA_NOTIFICATION_ENABLED` default `true`
- `LLM_HA_NOTIFICATION_TITLE` default `Home Assistant AI Analysis`
- `LLM_HA_NOTIFICATION_ID` default `ha_ai_llm_analysis_latest`
- `LLM_HA_NOTIFICATION_MAX_CHARS` default `6000`
- `LLM_HA_NOTIFICATION_REQUEST_TIMEOUT_MS` default `10000`
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
- `HA_ENVIRONMENT_SNAPSHOTS_RETENTION_DAYS` default `60`
- `HA_USAGE_SNAPSHOTS_RETENTION_DAYS` default `180`
- `AGENT_RUNS_RETENTION_DAYS` default `180`
- `ORPHAN_ANALYSIS_RESULTS_RETENTION_DAYS` default `180`
- `RETENTION_BATCH_SIZE` default `50000`

Automation snapshot settings:

- `HA_TOKEN` required
- `HA_HTTP_URL` optional explicit HTTP base URL (derived from `HA_WS_URL` when unset)
- `AUTOMATION_SNAPSHOT_SCHEDULE_TIME` default `03:15`
- `AUTOMATION_SNAPSHOT_SCHEDULE_TIMEZONE` default `ANALYTICS_TIMEZONE` or `UTC`
- `AUTOMATION_SNAPSHOT_INCLUDE_CONFIG` default `true`
- `AUTOMATION_SNAPSHOT_REQUEST_TIMEOUT_MS` default `10000`
- `AUTOMATION_SNAPSHOT_WS_REQUEST_TIMEOUT_MS` default `10000`
- `AUTOMATION_SNAPSHOT_CONFIG_FETCH_CONCURRENCY` default `5`
- `AUTOMATION_SNAPSHOT_INCLUDE_ENVIRONMENT_INVENTORY` default `true`
- `AUTOMATION_SNAPSHOT_INCLUDE_USAGE_SNAPSHOTS` default `true`

Daily home summary settings:

- `DAILY_SUMMARY_SCHEDULE_TIME` default `00:10`
- `DAILY_SUMMARY_SCHEDULE_TIMEZONE` default `ANALYTICS_TIMEZONE` or `UTC`
- `DAILY_SUMMARY_TARGET_DAY_OFFSET` default `1` (summarize yesterday when running after midnight)
- `DAILY_SUMMARY_BASELINE_DAYS` default `7`
- `DAILY_SUMMARY_MIN_BASELINE_DAYS` default `3`
- `DAILY_SUMMARY_ANOMALY_ZSCORE_THRESHOLD` default `2`
- `DAILY_SUMMARY_ANOMALY_MIN_DELTA` default `25`
- `DAILY_SUMMARY_TOP_CHANGES_LIMIT` default `8`
- `DAILY_SUMMARY_TOP_SUBJECTS_LIMIT` default `5`
- `DAILY_SUMMARY_MAX_RESOURCE_USAGE_ITEMS_PER_TYPE` default `5`
- `DAILY_SUMMARY_NOTIFICATION_ENABLED` default `true`
- `DAILY_SUMMARY_NOTIFICATION_TITLE` default `Daily Home Summary`
- `DAILY_SUMMARY_NOTIFICATION_ID` default `ha_ai_daily_summary_latest`
- `DAILY_SUMMARY_NOTIFICATION_MAX_CHARS` default `6000`
- `DAILY_SUMMARY_NOTIFICATION_REQUEST_TIMEOUT_MS` default `10000`

## Output and Persistence

A successful run writes:

- `agent_runs` lifecycle row (`running` -> `completed`)
- ranked `insights`
- linked `evidence`
- `recommendations` with `status='proposed'`
- final report row in `analysis_results` via `publishReport`
- Home Assistant `persistent_notification` (`persistent_notification.create`) with a readable summary of the run when notification env is enabled and HA auth is configured
- For daily-home-summary runs: `agent_runs` (`run_type='daily_home_summary'`) + report row in `analysis_results` + optional Home Assistant `persistent_notification`

Automation snapshot sync writes timestamped rows into `automation_snapshots` for:
- automation entities
- scripts
- scenes
- blueprint references/metadata (when discoverable)

It also writes Home Assistant environment inventory snapshots to `ha_environment_snapshots` for:
- device registry entries
- service registry definitions
- integration/config entries (installed apps/integrations)
- add-ons when available from Supervisor endpoints

It also writes utility/resource usage snapshots to `ha_usage_snapshots` for sensors inferred as:
- energy
- water
- gas
- power

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
