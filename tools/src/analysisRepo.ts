import type { QueryResultRow } from 'pg';

import type { SqlQueryable } from './db.js';
import type {
  HomeAssistantInventory,
  HomeAssistantInventoryItem,
  HomeAssistantInventoryType,
  NormalizedInsight,
  ResourceUsageReading,
  ResourceUsageSnapshot,
  ResourceUsageType,
} from './llm/types.js';

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
  getLatestEnvironmentInventory(db: SqlQueryable, maxItemsPerType: number): Promise<HomeAssistantInventory | null>;
  getLatestResourceUsageSnapshot(db: SqlQueryable, maxItemsPerType: number): Promise<ResourceUsageSnapshot | null>;
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

const LATEST_ENVIRONMENT_INVENTORY_SQL = `
WITH latest AS (
  SELECT MAX(captured_at) AS captured_at
  FROM ha_environment_snapshots
),
snapshot_rows AS (
  SELECT
    h.snapshot_type,
    h.resource_id,
    h.label,
    h.metadata,
    h.captured_at,
    ROW_NUMBER() OVER (
      PARTITION BY h.snapshot_type
      ORDER BY COALESCE(NULLIF(h.label, ''), h.resource_id), h.resource_id
    ) AS row_number_by_type,
    COUNT(*) OVER (PARTITION BY h.snapshot_type) AS total_count_by_type
  FROM ha_environment_snapshots h
  JOIN latest l
    ON l.captured_at IS NOT NULL
   AND h.captured_at = l.captured_at
)
SELECT
  snapshot_type,
  resource_id,
  label,
  metadata,
  captured_at,
  total_count_by_type
FROM snapshot_rows
WHERE row_number_by_type <= $1
ORDER BY snapshot_type ASC, row_number_by_type ASC
`;

const LATEST_USAGE_SNAPSHOT_SQL = `
WITH latest AS (
  SELECT MAX(captured_at) AS captured_at
  FROM ha_usage_snapshots
),
snapshot_rows AS (
  SELECT
    h.usage_type,
    h.entity_id,
    h.reading_numeric,
    h.reading_text,
    h.unit,
    h.metadata,
    h.captured_at,
    ROW_NUMBER() OVER (
      PARTITION BY h.usage_type
      ORDER BY
        h.reading_numeric DESC NULLS LAST,
        h.entity_id ASC
    ) AS row_number_by_type,
    COUNT(*) OVER (PARTITION BY h.usage_type) AS total_count_by_type
  FROM ha_usage_snapshots h
  JOIN latest l
    ON l.captured_at IS NOT NULL
   AND h.captured_at = l.captured_at
)
SELECT
  usage_type,
  entity_id,
  reading_numeric,
  reading_text,
  unit,
  metadata,
  captured_at,
  total_count_by_type
FROM snapshot_rows
WHERE row_number_by_type <= $1
ORDER BY usage_type ASC, row_number_by_type ASC
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

  async getLatestEnvironmentInventory(db, maxItemsPerType) {
    type Row = {
      snapshot_type: HomeAssistantInventoryType | string;
      resource_id: string;
      label: string | null;
      metadata: unknown;
      captured_at: string | Date;
      total_count_by_type: number | string;
    };

    let result: { rows: Row[] };
    try {
      result = await db.query<Row>(LATEST_ENVIRONMENT_INVENTORY_SQL, [maxItemsPerType]);
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : '';
      if (code === '42P01') {
        return null;
      }
      throw error;
    }

    if (result.rows.length === 0) {
      return null;
    }

    const countsByType: Record<HomeAssistantInventoryType, number> = {
      device: 0,
      service: 0,
      integration: 0,
      addon: 0,
    };
    const truncatedByType: Record<HomeAssistantInventoryType, number> = {
      device: 0,
      service: 0,
      integration: 0,
      addon: 0,
    };
    const itemsByType: Record<HomeAssistantInventoryType, HomeAssistantInventoryItem[]> = {
      device: [],
      service: [],
      integration: [],
      addon: [],
    };

    const capturedAt = new Date(result.rows[0].captured_at).toISOString();

    for (const row of result.rows) {
      const type = row.snapshot_type;
      if (type !== 'device' && type !== 'service' && type !== 'integration' && type !== 'addon') {
        continue;
      }

      const totalCount = toNumber(row.total_count_by_type);
      countsByType[type] = Math.max(countsByType[type], totalCount);
      itemsByType[type].push({
        resourceId: row.resource_id,
        label: row.label,
        metadata:
          row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
            ? (row.metadata as Record<string, unknown>)
            : {},
      });
    }

    for (const type of ['device', 'service', 'integration', 'addon'] as const) {
      const explicitCount = countsByType[type];
      const fallbackCount = itemsByType[type].length;
      const actualCount = explicitCount > 0 ? explicitCount : fallbackCount;
      countsByType[type] = actualCount;
      truncatedByType[type] = Math.max(0, actualCount - itemsByType[type].length);
    }

    return {
      capturedAt,
      countsByType,
      truncatedByType,
      itemsByType,
    };
  },

  async getLatestResourceUsageSnapshot(db, maxItemsPerType) {
    type Row = {
      usage_type: ResourceUsageType | string;
      entity_id: string;
      reading_numeric: number | string | null;
      reading_text: string;
      unit: string | null;
      metadata: unknown;
      captured_at: string | Date;
      total_count_by_type: number | string;
    };

    let result: { rows: Row[] };
    try {
      result = await db.query<Row>(LATEST_USAGE_SNAPSHOT_SQL, [maxItemsPerType]);
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : '';
      if (code === '42P01') {
        return null;
      }
      throw error;
    }

    if (result.rows.length === 0) {
      return null;
    }

    const countsByType: Record<ResourceUsageType, number> = {
      energy: 0,
      water: 0,
      gas: 0,
      power: 0,
    };
    const truncatedByType: Record<ResourceUsageType, number> = {
      energy: 0,
      water: 0,
      gas: 0,
      power: 0,
    };
    const itemsByType: Record<ResourceUsageType, ResourceUsageReading[]> = {
      energy: [],
      water: [],
      gas: [],
      power: [],
    };

    const capturedAt = new Date(result.rows[0].captured_at).toISOString();
    for (const row of result.rows) {
      const type = row.usage_type;
      if (type !== 'energy' && type !== 'water' && type !== 'gas' && type !== 'power') {
        continue;
      }

      countsByType[type] = Math.max(countsByType[type], toNumber(row.total_count_by_type));
      itemsByType[type].push({
        entityId: row.entity_id,
        readingNumeric: row.reading_numeric === null ? null : Number(row.reading_numeric),
        readingText: row.reading_text,
        unit: row.unit,
        metadata:
          row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
            ? (row.metadata as Record<string, unknown>)
            : {},
      });
    }

    for (const type of ['energy', 'water', 'gas', 'power'] as const) {
      const explicitCount = countsByType[type];
      const fallbackCount = itemsByType[type].length;
      const actualCount = explicitCount > 0 ? explicitCount : fallbackCount;
      countsByType[type] = actualCount;
      truncatedByType[type] = Math.max(0, actualCount - itemsByType[type].length);
    }

    return {
      capturedAt,
      countsByType,
      truncatedByType,
      itemsByType,
    };
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
