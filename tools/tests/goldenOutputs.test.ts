import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { getDailySummary, getTopChanges, publishReport, type TimeWindow, traceContext } from '../src/agentTools.js';
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
});
