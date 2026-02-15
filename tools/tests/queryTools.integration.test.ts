import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { getDailySummary, getTopChanges, publishReport, traceContext } from '../src/agentTools.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const shouldRun = Boolean(TEST_DB_URL);

describe.skipIf(!shouldRun)('tool query integrations', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });

    await pool.query(`
      CREATE TABLE IF NOT EXISTS events (
        id BIGSERIAL PRIMARY KEY,
        event_type TEXT NOT NULL,
        event_time TIMESTAMPTZ NOT NULL,
        domain TEXT,
        entity_id TEXT,
        service TEXT,
        context_id TEXT,
        parent_context_id TEXT,
        user_id TEXT,
        data JSONB NOT NULL,
        dedupe_key TEXT,
        collector_instance TEXT NOT NULL DEFAULT 'test',
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS trace_contexts (
        id BIGSERIAL PRIMARY KEY,
        context_id TEXT NOT NULL UNIQUE,
        root_context_id TEXT,
        related_context_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS analysis_results (
        id BIGSERIAL PRIMARY KEY,
        agent_run_id BIGINT,
        report_markdown TEXT NOT NULL,
        report_json JSONB NOT NULL,
        published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await pool.query('TRUNCATE TABLE events, trace_contexts, analysis_results RESTART IDENTITY CASCADE');

    await pool.query(
      `INSERT INTO events (event_type, event_time, domain, entity_id, service, context_id, parent_context_id, user_id, data, dedupe_key)
       VALUES
       ('state_changed', '2026-01-01T23:10:00.000Z', 'light', 'light.kitchen', NULL, 'ctx-root', NULL, 'user-1', '{}'::jsonb, 'old-1'),
       ('call_service',  '2026-01-01T23:15:00.000Z', 'light', NULL, 'turn_on', 'ctx-root', NULL, 'user-1', '{}'::jsonb, 'old-2'),
       ('state_changed', '2026-01-01T23:20:00.000Z', 'sensor', 'sensor.outdoor_temp', NULL, 'ctx-root', NULL, 'user-1', '{}'::jsonb, 'old-3'),
       ('state_changed', '2026-01-01T23:25:00.000Z', 'sensor', 'sensor.outdoor_temp', NULL, 'ctx-root', NULL, 'user-1', '{}'::jsonb, 'old-4'),
       ('state_changed', '2026-01-01T23:30:00.000Z', 'sensor', 'sensor.outdoor_temp', NULL, 'ctx-root', NULL, 'user-1', '{}'::jsonb, 'old-5'),
       ('state_changed', '2026-01-01T23:35:00.000Z', 'sensor', 'sensor.outdoor_temp', NULL, 'ctx-root', NULL, 'user-1', '{}'::jsonb, 'old-6'),

       ('state_changed', '2026-01-02T00:05:00.000Z', 'light', 'light.kitchen', NULL, 'ctx-child', 'ctx-root', 'user-1', '{}'::jsonb, 'new-1'),
       ('state_changed', '2026-01-02T00:06:00.000Z', 'light', 'light.kitchen', NULL, 'ctx-child', 'ctx-root', 'user-1', '{}'::jsonb, 'new-2'),
       ('state_changed', '2026-01-02T00:07:00.000Z', 'light', 'light.kitchen', NULL, 'ctx-child', 'ctx-root', 'user-1', '{}'::jsonb, 'new-3'),
       ('call_service',  '2026-01-02T00:08:00.000Z', 'light', NULL, 'turn_on', 'ctx-child', 'ctx-root', 'user-1', '{}'::jsonb, 'new-4'),
       ('call_service',  '2026-01-02T00:09:00.000Z', 'light', NULL, 'turn_on', 'ctx-child', 'ctx-root', 'user-1', '{}'::jsonb, 'new-5'),
       ('call_service',  '2026-01-02T00:10:00.000Z', 'light', NULL, 'turn_on', 'ctx-leaf', 'ctx-child', 'user-1', '{}'::jsonb, 'new-6'),
       ('call_service',  '2026-01-02T00:11:00.000Z', 'light', NULL, 'turn_on', 'ctx-leaf', 'ctx-child', 'user-1', '{}'::jsonb, 'new-7'),
       ('state_changed', '2026-01-02T00:12:00.000Z', 'sensor', 'sensor.outdoor_temp', NULL, 'ctx-leaf', 'ctx-child', 'user-1', '{}'::jsonb, 'new-8')`,
    );

    await pool.query(
      `INSERT INTO trace_contexts (context_id, root_context_id, related_context_ids, metadata)
       VALUES ('ctx-root', 'ctx-root', '["ctx-child", "ctx-leaf"]'::jsonb, '{"source":"test"}'::jsonb)`,
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  test('getDailySummary returns aggregated counts', async () => {
    const summary = await getDailySummary('2026-01-02', pool, 'UTC');

    if ('status' in summary) {
      throw new Error('getDailySummary unexpectedly returned stub');
    }

    expect(summary.day).toBe('2026-01-02');
    expect(summary.totalEvents).toBe(8);
    expect(summary.uniqueEntities).toBe(2);
    expect(summary.stateChanges).toBe(4);
    expect(summary.serviceCalls).toBe(4);
  });

  test('getTopChanges ranks entity/service deltas', async () => {
    const topChanges = await getTopChanges(
      {
        start: '2026-01-02T00:00:00.000Z',
        end: '2026-01-02T01:00:00.000Z',
      },
      3,
      pool,
    );

    if ('status' in topChanges) {
      throw new Error('getTopChanges unexpectedly returned stub');
    }

    expect(topChanges.rows.length).toBe(3);
    expect(topChanges.rows[0]).toMatchObject({ subjectType: 'service', subjectId: 'light.turn_on', delta: 3 });
    expect(topChanges.rows[1]).toMatchObject({ subjectType: 'entity', subjectId: 'sensor.outdoor_temp', delta: -3 });
    expect(topChanges.rows[2]).toMatchObject({ subjectType: 'entity', subjectId: 'light.kitchen', delta: 2 });
  });

  test('traceContext resolves parent/child context graph and events', async () => {
    const trace = await traceContext('ctx-child', pool);

    if ('status' in trace) {
      throw new Error('traceContext unexpectedly returned stub');
    }

    expect(trace.requestedContextId).toBe('ctx-child');
    expect(trace.rootContextId).toBe('ctx-root');
    expect(trace.contextDepth.map((item) => item.contextId)).toEqual(
      expect.arrayContaining(['ctx-root', 'ctx-child', 'ctx-leaf']),
    );
    expect(trace.events.length).toBeGreaterThanOrEqual(8);
  });

  test('publishReport persists analysis_results row', async () => {
    const published = await publishReport('# test report', { ok: true }, pool, null);

    expect(published.status).toBe('published');
    expect(published.analysisResultId).toBeTypeOf('number');
    expect(published.payloadKeys).toEqual(['ok']);
  });
});
