import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import type { Pool } from 'pg';

import { computeNextScheduledRunAt } from './analyticsJob.js';
import { createToolsPool } from './db.js';

type ScheduleTime = {
  hour: number;
  minute: number;
};

export type RetentionConfig = {
  databaseUrl: string;
  timezone: string;
  scheduleTime: ScheduleTime;
  eventsRetentionDays: number;
  eventsPartitionLookbackDays: number;
  eventsPartitionPrecreateDays: number;
  traceContextsRetentionDays: number;
  entitySnapshotsRetentionDays: number;
  automationSnapshotsRetentionDays: number;
  haEnvironmentSnapshotsRetentionDays: number;
  haUsageSnapshotsRetentionDays: number;
  agentRunsRetentionDays: number;
  orphanAnalysisResultsRetentionDays: number;
  batchSize: number;
};

type RetentionPassStats = {
  eventsTablePartitioned: boolean;
  partitionsCreated: number;
  partitionsDropped: number;
  legacyEventsDeleted: number;
  rowsDeleted: {
    traceContexts: number;
    entitySnapshots: number;
    automationSnapshots: number;
    haEnvironmentSnapshots: number;
    haUsageSnapshots: number;
    agentRuns: number;
    orphanAnalysisResults: number;
  };
};

const parseNumber = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined) {
    return fallback;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return fallback;
  }

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parsePositiveInt = (raw: string | undefined, fallback: number): number => {
  const parsed = Math.floor(parseNumber(raw, fallback));
  return parsed > 0 ? parsed : fallback;
};

const parseScheduleTime = (raw: string | undefined): ScheduleTime => {
  const value = (raw ?? '03:30').trim();
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) {
    throw new Error(`RETENTION_SCHEDULE_TIME must be HH:MM (24h), received '${value}'`);
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`RETENTION_SCHEDULE_TIME is out of range: '${value}'`);
  }

  return { hour, minute };
};

const toNumber = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const resolveConfig = (): RetentionConfig => {
  const timezone = process.env.RETENTION_SCHEDULE_TIMEZONE ?? process.env.ANALYTICS_TIMEZONE ?? 'UTC';

  return {
    databaseUrl: process.env.DATABASE_URL ?? 'postgresql://ha_ai:ha_ai_dev_password@localhost:5432/ha_ai',
    timezone,
    scheduleTime: parseScheduleTime(process.env.RETENTION_SCHEDULE_TIME),
    eventsRetentionDays: parsePositiveInt(process.env.EVENTS_RETENTION_DAYS, 14),
    eventsPartitionLookbackDays: parsePositiveInt(process.env.EVENTS_PARTITION_LOOKBACK_DAYS, 2),
    eventsPartitionPrecreateDays: parsePositiveInt(process.env.EVENTS_PARTITION_PRECREATE_DAYS, 14),
    traceContextsRetentionDays: parsePositiveInt(process.env.TRACE_CONTEXTS_RETENTION_DAYS, 30),
    entitySnapshotsRetentionDays: parsePositiveInt(process.env.ENTITY_SNAPSHOTS_RETENTION_DAYS, 30),
    automationSnapshotsRetentionDays: parsePositiveInt(process.env.AUTOMATION_SNAPSHOTS_RETENTION_DAYS, 60),
    haEnvironmentSnapshotsRetentionDays: parsePositiveInt(process.env.HA_ENVIRONMENT_SNAPSHOTS_RETENTION_DAYS, 60),
    haUsageSnapshotsRetentionDays: parsePositiveInt(process.env.HA_USAGE_SNAPSHOTS_RETENTION_DAYS, 180),
    agentRunsRetentionDays: parsePositiveInt(process.env.AGENT_RUNS_RETENTION_DAYS, 180),
    orphanAnalysisResultsRetentionDays: parsePositiveInt(process.env.ORPHAN_ANALYSIS_RESULTS_RETENTION_DAYS, 180),
    batchSize: parsePositiveInt(process.env.RETENTION_BATCH_SIZE, 50_000),
  };
};

const deleteInBatches = async (pool: Pool, query: string, params: unknown[], batchSize: number): Promise<number> => {
  let totalDeleted = 0;

  while (true) {
    const result = await pool.query(query, [...params, batchSize]);
    const deleted = result.rowCount ?? 0;
    totalDeleted += deleted;

    if (deleted < batchSize) {
      break;
    }
  }

  return totalDeleted;
};

export const runRetentionPass = async (pool: Pool, config: RetentionConfig): Promise<RetentionPassStats> => {
  const partitionStatus = await pool.query<{ is_partitioned: boolean }>(
    `
      SELECT EXISTS (
        SELECT 1
        FROM pg_partitioned_table pt
        JOIN pg_class c ON c.oid = pt.partrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema()
          AND c.relname = 'events'
      ) AS is_partitioned
    `,
  );
  const eventsTablePartitioned = Boolean(partitionStatus.rows[0]?.is_partitioned);

  let partitionsCreated = 0;
  let partitionsDropped = 0;
  let legacyEventsDeleted = 0;

  if (eventsTablePartitioned) {
    const partitionWindowStart = new Date();
    partitionWindowStart.setUTCDate(partitionWindowStart.getUTCDate() - config.eventsPartitionLookbackDays);
    const partitionWindowEnd = new Date();
    partitionWindowEnd.setUTCDate(partitionWindowEnd.getUTCDate() + config.eventsPartitionPrecreateDays);

    const fromDay = partitionWindowStart.toISOString().slice(0, 10);
    const toDay = partitionWindowEnd.toISOString().slice(0, 10);
    const cutoffDay = new Date();
    cutoffDay.setUTCDate(cutoffDay.getUTCDate() - config.eventsRetentionDays);
    const cutoffDayIso = cutoffDay.toISOString().slice(0, 10);

    const createPartitionsResult = await pool.query<{ created_count: string | number }>(
      'SELECT ensure_events_partitions($1::date, $2::date) AS created_count',
      [fromDay, toDay],
    );
    const dropPartitionsResult = await pool.query<{ dropped_count: string | number }>(
      'SELECT drop_events_partitions_older_than($1::date) AS dropped_count',
      [cutoffDayIso],
    );

    partitionsCreated = toNumber(createPartitionsResult.rows[0]?.created_count);
    partitionsDropped = toNumber(dropPartitionsResult.rows[0]?.dropped_count);
  } else {
    legacyEventsDeleted = await deleteInBatches(
      pool,
      `
        WITH doomed AS (
          SELECT ctid
          FROM events
          WHERE event_time < NOW() - ($1::int || ' days')::interval
          LIMIT $2
        )
        DELETE FROM events t
        USING doomed d
        WHERE t.ctid = d.ctid
      `,
      [config.eventsRetentionDays],
      config.batchSize,
    );
  }

  const traceContextsDeleted = await deleteInBatches(
    pool,
    `
      WITH doomed AS (
        SELECT ctid
        FROM trace_contexts
        WHERE created_at < NOW() - ($1::int || ' days')::interval
        LIMIT $2
      )
      DELETE FROM trace_contexts t
      USING doomed d
      WHERE t.ctid = d.ctid
    `,
    [config.traceContextsRetentionDays],
    config.batchSize,
  );

  const entitySnapshotsDeleted = await deleteInBatches(
    pool,
    `
      WITH doomed AS (
        SELECT ctid
        FROM entity_snapshots
        WHERE captured_at < NOW() - ($1::int || ' days')::interval
        LIMIT $2
      )
      DELETE FROM entity_snapshots t
      USING doomed d
      WHERE t.ctid = d.ctid
    `,
    [config.entitySnapshotsRetentionDays],
    config.batchSize,
  );

  const automationSnapshotsDeleted = await deleteInBatches(
    pool,
    `
      WITH doomed AS (
        SELECT ctid
        FROM automation_snapshots
        WHERE captured_at < NOW() - ($1::int || ' days')::interval
        LIMIT $2
      )
      DELETE FROM automation_snapshots t
      USING doomed d
      WHERE t.ctid = d.ctid
    `,
    [config.automationSnapshotsRetentionDays],
    config.batchSize,
  );

  const haEnvironmentSnapshotsDeleted = await deleteInBatches(
    pool,
    `
      WITH doomed AS (
        SELECT ctid
        FROM ha_environment_snapshots
        WHERE captured_at < NOW() - ($1::int || ' days')::interval
        LIMIT $2
      )
      DELETE FROM ha_environment_snapshots t
      USING doomed d
      WHERE t.ctid = d.ctid
    `,
    [config.haEnvironmentSnapshotsRetentionDays],
    config.batchSize,
  );

  const haUsageSnapshotsDeleted = await deleteInBatches(
    pool,
    `
      WITH doomed AS (
        SELECT ctid
        FROM ha_usage_snapshots
        WHERE captured_at < NOW() - ($1::int || ' days')::interval
        LIMIT $2
      )
      DELETE FROM ha_usage_snapshots t
      USING doomed d
      WHERE t.ctid = d.ctid
    `,
    [config.haUsageSnapshotsRetentionDays],
    config.batchSize,
  );

  const agentRunsDeleted = await deleteInBatches(
    pool,
    `
      WITH doomed AS (
        SELECT ctid
        FROM agent_runs
        WHERE created_at < NOW() - ($1::int || ' days')::interval
        LIMIT $2
      )
      DELETE FROM agent_runs t
      USING doomed d
      WHERE t.ctid = d.ctid
    `,
    [config.agentRunsRetentionDays],
    config.batchSize,
  );

  const orphanAnalysisResultsDeleted = await deleteInBatches(
    pool,
    `
      WITH doomed AS (
        SELECT ctid
        FROM analysis_results
        WHERE agent_run_id IS NULL
          AND created_at < NOW() - ($1::int || ' days')::interval
        LIMIT $2
      )
      DELETE FROM analysis_results t
      USING doomed d
      WHERE t.ctid = d.ctid
    `,
    [config.orphanAnalysisResultsRetentionDays],
    config.batchSize,
  );

  return {
    eventsTablePartitioned,
    partitionsCreated,
    partitionsDropped,
    legacyEventsDeleted,
    rowsDeleted: {
      traceContexts: traceContextsDeleted,
      entitySnapshots: entitySnapshotsDeleted,
      automationSnapshots: automationSnapshotsDeleted,
      haEnvironmentSnapshots: haEnvironmentSnapshotsDeleted,
      haUsageSnapshots: haUsageSnapshotsDeleted,
      agentRuns: agentRunsDeleted,
      orphanAnalysisResults: orphanAnalysisResultsDeleted,
    },
  };
};

const runScheduler = async (pool: Pool, config: RetentionConfig): Promise<void> => {
  while (true) {
    const now = new Date();
    const nextRunAt = computeNextScheduledRunAt(now, config.scheduleTime, config.timezone);
    const waitMs = Math.max(0, nextRunAt.getTime() - now.getTime());

    console.info('next retention run planned', {
      now: now.toISOString(),
      nextRunAt: nextRunAt.toISOString(),
      waitMs,
      timezone: config.timezone,
      scheduleTime: `${String(config.scheduleTime.hour).padStart(2, '0')}:${String(config.scheduleTime.minute).padStart(
        2,
        '0',
      )}`,
    });

    await sleep(waitMs);

    try {
      const startedAt = new Date();
      const stats = await runRetentionPass(pool, config);
      console.info('retention pass completed', {
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
        ...stats,
      });
    } catch (error) {
      console.error('retention pass failed', {
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      });
    }
  }
};

export const runRetentionJob = async (args: string[] = process.argv.slice(2)): Promise<void> => {
  const mode = args.includes('--once') ? 'once' : 'schedule';
  const config = resolveConfig();
  const pool = createToolsPool(config.databaseUrl);

  try {
    if (mode === 'once') {
      const stats = await runRetentionPass(pool, config);
      console.info('retention pass completed', stats);
      return;
    }

    await runScheduler(pool, config);
  } finally {
    await pool.end();
  }
};

const isDirectExecution = (): boolean => {
  if (!process.argv[1]) {
    return false;
  }

  return fileURLToPath(import.meta.url) === process.argv[1];
};

if (isDirectExecution()) {
  void runRetentionJob().catch((error) => {
    console.error('retention job failed', {
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
    process.exitCode = 1;
  });
}
