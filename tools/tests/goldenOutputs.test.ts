import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import {
  correlate,
  entityTimeline,
  getAutomationSnapshot,
  getDailySummary,
  getTopChanges,
  listAutomations,
  publishReport,
  type TimeWindow,
  traceContext,
} from '../src/agentTools.js';
import type { SqlQueryable } from '../src/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fixturesDir = join(__dirname, 'fixtures');

const readFixture = async <T>(name: string): Promise<T> => {
  const raw = await readFile(join(fixturesDir, name), 'utf8');
  return JSON.parse(raw) as T;
};

describe('tool golden outputs', () => {
  test('getDailySummary matches golden output', async () => {
    const db: SqlQueryable = {
      query: (async () => ({
        rows: [
          {
            day: '2026-01-02',
            timezone: 'UTC',
            total_events: '8',
            unique_entities: '2',
            state_changes: '4',
            service_calls: '4',
          },
        ],
        rowCount: 1,
      })) as SqlQueryable['query'],
    };

    const result = await getDailySummary('2026-01-02', db, 'UTC');
    const golden = await readFixture<Record<string, unknown>>('getDailySummary.golden.json');

    expect(result).toEqual(golden);
  });

  test('getTopChanges matches golden output', async () => {
    const window: TimeWindow = {
      start: '2026-01-02T00:00:00.000Z',
      end: '2026-01-02T01:00:00.000Z',
    };

    const db: SqlQueryable = {
      query: (async () => ({
        rows: [
          {
            subject_type: 'service',
            subject_id: 'light.turn_on',
            current_count: '4',
            previous_count: '1',
            delta: '3',
          },
          {
            subject_type: 'entity',
            subject_id: 'sensor.outdoor_temp',
            current_count: '1',
            previous_count: '4',
            delta: '-3',
          },
        ],
        rowCount: 2,
      })) as SqlQueryable['query'],
    };

    const result = await getTopChanges(window, 2, db);
    const golden = await readFixture<Record<string, unknown>>('getTopChanges.golden.json');

    expect(result).toEqual(golden);
  });

  test('traceContext matches golden output', async () => {
    const db: SqlQueryable = {
      query: (async (sql: string) => {
        if (sql.includes('WITH RECURSIVE edges AS') || sql.includes('WITH RECURSIVE graph AS')) {
          return {
            rows: [
              { context_id: 'ctx-child', depth: 0 },
              { context_id: 'ctx-root', depth: 1 },
              { context_id: 'ctx-leaf', depth: 1 },
            ],
            rowCount: 3,
          };
        }

        if (sql.includes('FROM events') && sql.includes('context_id = ANY')) {
          return {
            rows: [
              {
                id: 101,
                event_time: '2026-01-02T00:05:00.000Z',
                event_type: 'state_changed',
                domain: 'light',
                entity_id: 'light.kitchen',
                service: null,
                context_id: 'ctx-child',
                parent_context_id: 'ctx-root',
                user_id: 'user-1',
                data: { event_type: 'state_changed' },
              },
              {
                id: 102,
                event_time: '2026-01-02T00:10:00.000Z',
                event_type: 'call_service',
                domain: 'light',
                entity_id: null,
                service: 'turn_on',
                context_id: 'ctx-leaf',
                parent_context_id: 'ctx-child',
                user_id: 'user-1',
                data: { event_type: 'call_service' },
              },
            ],
            rowCount: 2,
          };
        }

        if (sql.includes('FROM trace_contexts')) {
          return {
            rows: [
              {
                context_id: 'ctx-root',
                root_context_id: 'ctx-root',
                related_context_ids: ['ctx-child', 'ctx-leaf'],
                metadata: { source: 'golden' },
              },
            ],
            rowCount: 1,
          };
        }

        throw new Error(`unexpected SQL in golden traceContext test: ${sql}`);
      }) as SqlQueryable['query'],
    };

    const result = await traceContext('ctx-child', db);
    const golden = await readFixture<Record<string, unknown>>('traceContext.golden.json');

    expect(result).toEqual(golden);
  });

  test('publishReport matches golden output', async () => {
    const db: SqlQueryable = {
      query: (async () => ({
        rows: [{ id: '42', published_at: '2026-01-02T12:34:56.000Z' }],
        rowCount: 1,
      })) as SqlQueryable['query'],
    };

    const result = await publishReport('# Daily Summary', { runId: 'run-1', insights: [] }, db, 7);
    const golden = await readFixture<Record<string, unknown>>('publishReport.golden.json');

    expect(result).toEqual(golden);
  });

  test('entityTimeline matches golden output', async () => {
    const db: SqlQueryable = {
      query: (async () => ({
        rows: [
          {
            bucket_start: '2026-01-02T00:00:00.000Z',
            total_events: '3',
            state_changes: '2',
            service_calls: '1',
          },
        ],
        rowCount: 1,
      })) as SqlQueryable['query'],
    };

    const result = await entityTimeline(
      'light.kitchen',
      '2026-01-02T00:00:00.000Z',
      '2026-01-02T01:00:00.000Z',
      'hour',
      db,
    );
    const golden = await readFixture<Record<string, unknown>>('entityTimeline.golden.json');

    expect(result).toEqual(golden);
  });

  test('correlate matches golden output', async () => {
    const window: TimeWindow = {
      start: '2026-01-02T00:00:00.000Z',
      end: '2026-01-02T01:00:00.000Z',
    };

    const db: SqlQueryable = {
      query: (async () => ({
        rows: [
          {
            subject_type: 'service',
            subject_id: 'light.turn_on',
            overlap_contexts: '2',
            overlap_events: '4',
            correlation_score: '1',
            context_count: '2',
          },
          {
            subject_type: 'entity',
            subject_id: 'sensor.outdoor_temp',
            overlap_contexts: '1',
            overlap_events: '1',
            correlation_score: '0.5',
            context_count: '2',
          },
        ],
        rowCount: 2,
      })) as SqlQueryable['query'],
    };

    const result = await correlate('light.kitchen', window, 2, db);
    const golden = await readFixture<Record<string, unknown>>('correlate.golden.json');

    expect(result).toEqual(golden);
  });

  test('getAutomationSnapshot matches golden output', async () => {
    const db: SqlQueryable = {
      query: (async (_sql: string, params?: unknown[]) => {
        if (params?.length === 1) {
          return {
            rows: [
              {
                automation_id: 'automation.kitchen_lights',
                alias: 'Kitchen Lights',
                is_enabled: true,
                trigger_config: [{ platform: 'time' }],
                action_config: [{ service: 'light.turn_on' }],
                conditions_config: [],
                metadata: { source: 'golden' },
                captured_at: '2026-01-02T00:00:00.000Z',
              },
            ],
            rowCount: 1,
          };
        }

        return {
          rows: [
            {
              total_events: '3',
              state_changes: '1',
              service_calls: '2',
              last_event_at: '2026-01-02T00:10:00.000Z',
            },
          ],
          rowCount: 1,
        };
      }) as SqlQueryable['query'],
    };

    const result = await getAutomationSnapshot('automation.kitchen_lights', db);
    const golden = await readFixture<Record<string, unknown>>('getAutomationSnapshot.golden.json');

    expect(result).toEqual(golden);
  });

  test('listAutomations matches golden output', async () => {
    const db: SqlQueryable = {
      query: (async () => ({
        rows: [
          {
            automation_id: 'automation.kitchen_lights',
            alias: 'Kitchen Lights',
            is_enabled: true,
            metadata: { source: 'golden' },
            captured_at: '2026-01-02T00:00:00.000Z',
          },
          {
            automation_id: 'automation.night_mode',
            alias: 'Night Mode',
            is_enabled: false,
            metadata: {},
            captured_at: '2026-01-01T22:00:00.000Z',
          },
        ],
        rowCount: 2,
      })) as SqlQueryable['query'],
    };

    const result = await listAutomations({ limit: 2 }, db);
    const golden = await readFixture<Record<string, unknown>>('listAutomations.golden.json');

    expect(result).toEqual(golden);
  });
});
