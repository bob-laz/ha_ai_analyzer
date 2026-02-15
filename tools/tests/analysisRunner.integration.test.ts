import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { runAnalysis } from '../src/analysisRunner.js';
import type { LLMProvider } from '../src/llm/provider.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const shouldRun = Boolean(TEST_DB_URL);

describe.skipIf(!shouldRun)('analysis runner integrations', () => {
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
    await pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_events_event_time_dedupe_key_unique_test ON events (event_time, dedupe_key)`,
    );

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
      CREATE TABLE IF NOT EXISTS agent_runs (
        id BIGSERIAL PRIMARY KEY,
        run_uuid TEXT NOT NULL DEFAULT md5(random()::text || clock_timestamp()::text),
        run_type TEXT NOT NULL,
        status TEXT NOT NULL,
        window_start TIMESTAMPTZ,
        window_end TIMESTAMPTZ,
        config JSONB NOT NULL DEFAULT '{}'::jsonb,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS insights (
        id BIGSERIAL PRIMARY KEY,
        agent_run_id BIGINT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        rank INT NOT NULL,
        category TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        root_cause TEXT,
        confidence NUMERIC(5,4),
        severity NUMERIC(5,4),
        recommendation JSONB,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS evidence (
        id BIGSERIAL PRIMARY KEY,
        insight_id BIGINT REFERENCES insights(id) ON DELETE CASCADE,
        evidence_type TEXT NOT NULL,
        event_id BIGINT,
        entity_id TEXT,
        context_id TEXT,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS analysis_results (
        id BIGSERIAL PRIMARY KEY,
        agent_run_id BIGINT REFERENCES agent_runs(id) ON DELETE CASCADE,
        report_markdown TEXT NOT NULL,
        report_json JSONB NOT NULL,
        published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS recommendations (
        id BIGSERIAL PRIMARY KEY,
        agent_run_id BIGINT REFERENCES agent_runs(id) ON DELETE CASCADE,
        insight_id BIGINT REFERENCES insights(id) ON DELETE SET NULL,
        recommendation_type TEXT NOT NULL,
        target_automation_id TEXT,
        change_payload JSONB NOT NULL,
        status TEXT NOT NULL DEFAULT 'proposed',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await pool.query(`
      TRUNCATE TABLE recommendations, analysis_results, evidence, insights, agent_runs, trace_contexts, events
      RESTART IDENTITY CASCADE
    `);

    await pool.query(`
      INSERT INTO events (event_type, event_time, domain, entity_id, service, context_id, parent_context_id, user_id, data, dedupe_key)
      VALUES
      ('call_service',  '2026-01-01T00:10:00.000Z', 'light', NULL, 'turn_on', 'ctx-root', NULL, 'user-1', '{}'::jsonb, 'old-1'),
      ('state_changed', '2026-01-02T00:05:00.000Z', 'light', 'light.kitchen', NULL, 'ctx-child', 'ctx-root', 'user-1', '{}'::jsonb, 'new-1'),
      ('call_service',  '2026-01-02T00:06:00.000Z', 'light', NULL, 'turn_on', 'ctx-child', 'ctx-root', 'user-1', '{}'::jsonb, 'new-2'),
      ('call_service',  '2026-01-02T00:07:00.000Z', 'light', NULL, 'turn_on', 'ctx-leaf', 'ctx-child', 'user-1', '{}'::jsonb, 'new-3')
    `);

    await pool.query(`
      INSERT INTO trace_contexts (context_id, root_context_id, related_context_ids, metadata)
      VALUES ('ctx-root', 'ctx-root', '["ctx-child","ctx-leaf"]'::jsonb, '{"source":"integration"}'::jsonb)
      ON CONFLICT (context_id) DO NOTHING
    `);
  });

  afterAll(async () => {
    await pool.end();
  });

  test('manual run inserts artifacts and linked report', async () => {
    const provider: LLMProvider = {
      analyze: async (input) => ({
        run_id: input.runId,
        generated_at: input.generatedAt,
        summary: 'Integration analysis summary',
        ranked_insights: [
          {
            rank: 1,
            title: 'Turn on traffic increased',
            confidence: 0.8,
            root_cause: 'Expected nighttime automation cycle',
            evidence_ids: [input.evidenceCatalog[0]?.evidenceId ?? 'change:service:light.turn_on'],
          },
        ],
        proposed_automation_changes: [
          {
            automation_id: 'automation.night_lights',
            change_type: 'adjust_trigger',
            reasoning: 'Reduce unnecessary duplicate service calls',
            related_insight_rank: 1,
          },
        ],
      }),
    };

    const result = await runAnalysis(
      pool,
      provider,
      {
        runType: 'llm_analysis',
        timezone: 'UTC',
        windowHours: 24,
        maxInsights: 5,
        maxTopChanges: 20,
        maxTraceContexts: 10,
        maxEventsPerContext: 60,
        traceMaxDepth: 6,
      },
      {
        now: () => new Date('2026-01-02T01:00:00.000Z'),
      },
    );

    const runRows = await pool.query<{ status: string }>('SELECT status FROM agent_runs WHERE id = $1', [
      result.agentRunId,
    ]);
    const insightRows = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM insights WHERE agent_run_id = $1',
      [result.agentRunId],
    );
    const evidenceRows = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM evidence e
       JOIN insights i ON i.id = e.insight_id
       WHERE i.agent_run_id = $1`,
      [result.agentRunId],
    );
    const recommendationRows = await pool.query<{ status: string }>(
      'SELECT status FROM recommendations WHERE agent_run_id = $1',
      [result.agentRunId],
    );
    const reportRows = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM analysis_results WHERE agent_run_id = $1',
      [result.agentRunId],
    );

    expect(result.analysisResultId).toBeTypeOf('number');
    expect(runRows.rows[0]?.status).toBe('completed');
    expect(Number(insightRows.rows[0]?.count ?? '0')).toBe(1);
    expect(Number(evidenceRows.rows[0]?.count ?? '0')).toBeGreaterThanOrEqual(1);
    expect(recommendationRows.rows[0]?.status).toBe('proposed');
    expect(Number(reportRows.rows[0]?.count ?? '0')).toBe(1);
  });

  test('invalid provider output marks run failed', async () => {
    const provider: LLMProvider = {
      analyze: async (input) => ({
        run_id: input.runId,
        generated_at: input.generatedAt,
        ranked_insights: [],
        proposed_automation_changes: [],
      }),
    };

    await expect(
      runAnalysis(
        pool,
        provider,
        {
          runType: 'llm_analysis',
          timezone: 'UTC',
          windowHours: 24,
          maxInsights: 5,
          maxTopChanges: 20,
          maxTraceContexts: 10,
          maxEventsPerContext: 60,
          traceMaxDepth: 6,
        },
        {
          now: () => new Date('2026-01-02T01:00:00.000Z'),
        },
      ),
    ).rejects.toThrow();

    const latestRun = await pool.query<{ status: string; config: Record<string, unknown> }>(
      'SELECT status, config FROM agent_runs ORDER BY id DESC LIMIT 1',
    );
    expect(latestRun.rows[0]?.status).toBe('failed');
    expect(latestRun.rows[0]?.config).toHaveProperty('last_error');
  });
});
