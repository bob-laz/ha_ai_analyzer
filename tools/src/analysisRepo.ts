import type { QueryResultRow } from 'pg';

import type { SqlQueryable } from './db.js';
import type { NormalizedInsight } from './llm/types.js';

const toNumber = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export type AgentRunRecord = {
  id: number;
  runUuid: string;
};

export type InsightRecord = {
  id: number;
  rank: number;
};

export type EvidenceInsert = {
  insightId: number;
  evidenceType: string;
  eventId: number | null;
  entityId: string | null;
  contextId: string | null;
  payload: Record<string, unknown>;
};

export type RecommendationInsert = {
  insightId: number | null;
  recommendationType: string;
  targetAutomationId: string | null;
  changePayload: Record<string, unknown>;
  status: 'proposed';
};

export interface AnalysisRepo {
  createAgentRun(
    db: SqlQueryable,
    params: {
      runType: string;
      status: string;
      windowStart: string;
      windowEnd: string;
      config: Record<string, unknown>;
    },
  ): Promise<AgentRunRecord>;
  completeAgentRun(db: SqlQueryable, runId: number, metadata: Record<string, unknown>): Promise<void>;
  failAgentRun(db: SqlQueryable, runId: number, error: Record<string, unknown>): Promise<void>;
  listTopContextIds(db: SqlQueryable, windowStart: string, windowEnd: string, limit: number): Promise<string[]>;
  insertInsights(db: SqlQueryable, runId: number, insights: NormalizedInsight[]): Promise<InsightRecord[]>;
  insertEvidence(db: SqlQueryable, evidenceRows: EvidenceInsert[]): Promise<void>;
  insertRecommendations(db: SqlQueryable, runId: number, recommendations: RecommendationInsert[]): Promise<void>;
}

const CREATE_AGENT_RUN_SQL = `
INSERT INTO agent_runs (run_type, status, window_start, window_end, config)
VALUES ($1, $2, $3, $4, $5::jsonb)
RETURNING id, run_uuid
`;

const COMPLETE_AGENT_RUN_SQL = `
UPDATE agent_runs
SET status = 'completed',
    completed_at = NOW(),
    config = COALESCE(config, '{}'::jsonb) || $2::jsonb
WHERE id = $1
`;

const FAIL_AGENT_RUN_SQL = `
UPDATE agent_runs
SET status = 'failed',
    completed_at = NOW(),
    config = COALESCE(config, '{}'::jsonb) || $2::jsonb
WHERE id = $1
`;

const TOP_CONTEXTS_SQL = `
SELECT context_id, COUNT(*)::bigint AS event_count
FROM events
WHERE event_time >= $1::timestamptz
  AND event_time < $2::timestamptz
  AND context_id IS NOT NULL
GROUP BY context_id
ORDER BY event_count DESC, context_id ASC
LIMIT $3
`;

const INSERT_INSIGHT_SQL = `
INSERT INTO insights (
  agent_run_id,
  rank,
  category,
  title,
  summary,
  root_cause,
  confidence,
  severity,
  recommendation,
  metadata
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9::jsonb)
RETURNING id, rank
`;

const INSERT_EVIDENCE_SQL = `
INSERT INTO evidence (
  insight_id,
  evidence_type,
  event_id,
  entity_id,
  context_id,
  payload
)
VALUES ($1, $2, $3, $4, $5, $6::jsonb)
`;

const INSERT_RECOMMENDATION_SQL = `
INSERT INTO recommendations (
  agent_run_id,
  insight_id,
  recommendation_type,
  target_automation_id,
  change_payload,
  status
)
VALUES ($1, $2, $3, $4, $5::jsonb, $6)
`;

export const analysisRepo: AnalysisRepo = {
  async createAgentRun(db, params) {
    const result = await db.query<{ id: number | string; run_uuid: string }>(CREATE_AGENT_RUN_SQL, [
      params.runType,
      params.status,
      params.windowStart,
      params.windowEnd,
      JSON.stringify(params.config),
    ]);

    const row = result.rows[0];
    if (!row) {
      throw new Error('failed to create agent run');
    }

    return {
      id: toNumber(row.id),
      runUuid: row.run_uuid,
    };
  },

  async completeAgentRun(db, runId, metadata) {
    await db.query(COMPLETE_AGENT_RUN_SQL, [runId, JSON.stringify(metadata)]);
  },

  async failAgentRun(db, runId, error) {
    await db.query(FAIL_AGENT_RUN_SQL, [runId, JSON.stringify({ last_error: error })]);
  },

  async listTopContextIds(db, windowStart, windowEnd, limit) {
    const result = await db.query<{ context_id: string }>(TOP_CONTEXTS_SQL, [windowStart, windowEnd, limit]);
    return result.rows.map((row) => row.context_id);
  },

  async insertInsights(db, runId, insights) {
    const rows: InsightRecord[] = [];
    for (const insight of insights) {
      const result = await db.query<{ id: number | string; rank: number | string }>(INSERT_INSIGHT_SQL, [
        runId,
        insight.rank,
        insight.category,
        insight.title,
        insight.summary,
        insight.rootCause,
        insight.confidence,
        insight.severity,
        JSON.stringify({ evidenceIds: insight.evidenceIds }),
      ]);

      const row = result.rows[0];
      if (!row) {
        throw new Error('failed to insert insight row');
      }

      rows.push({
        id: toNumber(row.id),
        rank: toNumber(row.rank),
      });
    }

    return rows;
  },

  async insertEvidence(db, evidenceRows) {
    for (const row of evidenceRows) {
      await db.query<QueryResultRow>(INSERT_EVIDENCE_SQL, [
        row.insightId,
        row.evidenceType,
        row.eventId,
        row.entityId,
        row.contextId,
        JSON.stringify(row.payload),
      ]);
    }
  },

  async insertRecommendations(db, runId, recommendations) {
    for (const recommendation of recommendations) {
      await db.query<QueryResultRow>(INSERT_RECOMMENDATION_SQL, [
        runId,
        recommendation.insightId,
        recommendation.recommendationType,
        recommendation.targetAutomationId,
        JSON.stringify(recommendation.changePayload),
        recommendation.status,
      ]);
    }
  },
};
