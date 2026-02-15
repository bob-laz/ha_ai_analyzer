import { describe, expect, test, vi } from 'vitest';

import { type RetentionConfig, runRetentionPass } from '../src/retentionJob.js';

describe('runRetentionPass', () => {
  test('creates/drops partitions and deletes old rows in batches', async () => {
    let traceDeleteCalls = 0;

    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('pg_partitioned_table')) {
          return {
            rows: [{ is_partitioned: true }],
            rowCount: 1,
          };
        }

        if (sql.includes('ensure_events_partitions')) {
          return {
            rows: [{ created_count: '2' }],
            rowCount: 1,
          };
        }

        if (sql.includes('drop_events_partitions_older_than')) {
          return {
            rows: [{ dropped_count: '1' }],
            rowCount: 1,
          };
        }

        if (sql.includes('FROM trace_contexts')) {
          traceDeleteCalls += 1;
          return {
            rows: [],
            rowCount: traceDeleteCalls === 1 ? 2 : 1,
          };
        }

        return {
          rows: [],
          rowCount: 0,
        };
      }),
    } as unknown as import('pg').Pool;

    const config: RetentionConfig = {
      databaseUrl: 'postgresql://ha_ai:ha_ai_dev_password@localhost:5432/ha_ai',
      timezone: 'UTC',
      scheduleTime: { hour: 3, minute: 30 },
      eventsRetentionDays: 14,
      eventsPartitionLookbackDays: 2,
      eventsPartitionPrecreateDays: 14,
      traceContextsRetentionDays: 30,
      entitySnapshotsRetentionDays: 30,
      automationSnapshotsRetentionDays: 60,
      agentRunsRetentionDays: 180,
      orphanAnalysisResultsRetentionDays: 180,
      batchSize: 2,
    };

    const stats = await runRetentionPass(pool, config);

    expect(stats.partitionsCreated).toBe(2);
    expect(stats.partitionsDropped).toBe(1);
    expect(stats.eventsTablePartitioned).toBe(true);
    expect(stats.legacyEventsDeleted).toBe(0);
    expect(stats.rowsDeleted.traceContexts).toBe(3);
    expect(stats.rowsDeleted.entitySnapshots).toBe(0);
    expect(stats.rowsDeleted.automationSnapshots).toBe(0);
    expect(stats.rowsDeleted.agentRuns).toBe(0);
    expect(stats.rowsDeleted.orphanAnalysisResults).toBe(0);
  });

  test('falls back to batched event deletes when events table is not partitioned', async () => {
    let eventsDeleteCalls = 0;

    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('pg_partitioned_table')) {
          return {
            rows: [{ is_partitioned: false }],
            rowCount: 1,
          };
        }

        if (sql.includes('FROM events')) {
          eventsDeleteCalls += 1;
          return {
            rows: [],
            rowCount: eventsDeleteCalls === 1 ? 2 : 0,
          };
        }

        return {
          rows: [],
          rowCount: 0,
        };
      }),
    } as unknown as import('pg').Pool;

    const config: RetentionConfig = {
      databaseUrl: 'postgresql://ha_ai:ha_ai_dev_password@localhost:5432/ha_ai',
      timezone: 'UTC',
      scheduleTime: { hour: 3, minute: 30 },
      eventsRetentionDays: 14,
      eventsPartitionLookbackDays: 2,
      eventsPartitionPrecreateDays: 14,
      traceContextsRetentionDays: 30,
      entitySnapshotsRetentionDays: 30,
      automationSnapshotsRetentionDays: 60,
      agentRunsRetentionDays: 180,
      orphanAnalysisResultsRetentionDays: 180,
      batchSize: 2,
    };

    const stats = await runRetentionPass(pool, config);

    expect(stats.eventsTablePartitioned).toBe(false);
    expect(stats.partitionsCreated).toBe(0);
    expect(stats.partitionsDropped).toBe(0);
    expect(stats.legacyEventsDeleted).toBe(2);
  });
});
