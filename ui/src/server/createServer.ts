import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import type {
  ActionAcceptedResponse,
  AutomationSnapshotsResponse,
  AnomalyCard,
  EntitySnapshotsResponse,
  EnvironmentSnapshotType,
  EnvironmentSnapshotsResponse,
  HealthResponse,
  LatestReportResponse,
  OverviewResponse,
  RecentEventRow,
  RecommendationRow,
  RecommendationStatus,
  RecommendationUpdateResponse,
  ResourceUsageResponse,
  RunRow,
} from '../shared/types.js';
import type { ActionRunner } from './actionRunner.js';
import { registerApiBasicAuth } from './auth.js';
import type { UiConfig } from './config.js';
import type { Queryable } from './db.js';

type CreateServerOptions = {
  config: UiConfig;
  db: Queryable;
  actionRunner: ActionRunner;
};

type DbTimestamp = string | Date;

type DbCountRow = {
  events_5m: string | number;
  events_1h: string | number;
  events_24h: string | number;
};

type DbRunRow = {
  id: string | number;
  run_uuid: string;
  run_type: string;
  status: string;
  window_start: DbTimestamp | null;
  window_end: DbTimestamp | null;
  started_at: DbTimestamp;
  completed_at: DbTimestamp | null;
  config: Record<string, unknown> | null;
};

type DbRecommendationRow = {
  id: string | number;
  agent_run_id: string | number | null;
  insight_id: string | number | null;
  recommendation_type: string;
  target_automation_id: string | null;
  status: RecommendationStatus;
  change_payload: Record<string, unknown> | null;
  created_at: DbTimestamp;
  updated_at: DbTimestamp;
  insight_rank: string | number | null;
  insight_title: string | null;
  insight_summary: string | null;
  run_uuid: string | null;
  run_type: string | null;
  run_started_at: DbTimestamp | null;
};

type DbDailySummaryRow = {
  report_id: string | number;
  target_day: string | null;
  anomaly_count: string | number;
  published_at: DbTimestamp;
};

type DbReportRow = {
  analysis_result_id: string | number;
  agent_run_id: string | number | null;
  run_uuid: string | null;
  published_at: DbTimestamp;
  report_markdown: string;
  report_json: Record<string, unknown> | null;
};

type DbEventRow = {
  id: string | number;
  event_time: DbTimestamp;
  event_type: string;
  domain: string | null;
  entity_id: string | null;
  service: string | null;
  context_id: string | null;
  parent_context_id: string | null;
  user_id: string | null;
  collector_instance: string;
  payload_preview: string;
};

type DbAnomalyRow = {
  analysis_result_id: string | number;
  run_uuid: string | null;
  target_day: string | null;
  published_at: DbTimestamp;
  metric: string;
  value: string | number | null;
  baseline_mean: string | number | null;
  delta: string | number | null;
  z_score: string | number | null;
};

type DbUsageRow = {
  usage_type: string;
  entity_id: string;
  reading_numeric: number | null;
  reading_text: string;
  unit: string | null;
  metadata: Record<string, unknown> | null;
  captured_at: DbTimestamp;
};

type DbAutomationSnapshotRow = {
  id: string | number;
  automation_id: string;
  alias: string | null;
  is_enabled: boolean | null;
  trigger_config: unknown;
  action_config: unknown;
  conditions_config: unknown;
  metadata: Record<string, unknown> | null;
  captured_at: DbTimestamp;
  created_at: DbTimestamp;
};

type DbEnvironmentSnapshotRow = {
  id: string | number;
  snapshot_type: string;
  resource_id: string;
  label: string | null;
  metadata: Record<string, unknown> | null;
  captured_at: DbTimestamp;
  created_at: DbTimestamp;
};

type DbEntitySnapshotRow = {
  id: string | number;
  entity_id: string;
  state: string | null;
  domain: string | null;
  attributes: Record<string, unknown> | null;
  context_id: string | null;
  captured_at: DbTimestamp;
  source_event_id: string | number | null;
  created_at: DbTimestamp;
};

type DbHealthRow = {
  db_time: DbTimestamp;
  db_version: string;
};

const clampLimit = (raw: unknown, fallback: number, max: number): number => {
  if (raw === undefined || raw === null || raw === '') {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  const normalized = Math.floor(parsed);
  if (normalized <= 0) {
    return fallback;
  }

  return Math.min(normalized, max);
};

const toNumber = (value: string | number | null | undefined): number => {
  if (value === null || value === undefined) {
    return 0;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const toIsoString = (value: DbTimestamp | null): string | null => {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toISOString();
};

const asRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
};

const asArray = (value: unknown): unknown[] => {
  return Array.isArray(value) ? value : [];
};

const asString = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const AUTOMATION_SNAPSHOT_TYPE_SQL =
  "COALESCE(NULLIF(metadata->>'snapshotType', ''), CASE WHEN automation_id LIKE 'blueprint:%' THEN 'blueprint' ELSE split_part(automation_id, '.', 1) END)";

const mapRunRow = (row: DbRunRow): RunRow => {
  return {
    id: toNumber(row.id),
    runUuid: row.run_uuid,
    runType: row.run_type,
    status: row.status,
    windowStart: toIsoString(row.window_start),
    windowEnd: toIsoString(row.window_end),
    startedAt: toIsoString(row.started_at) ?? new Date(0).toISOString(),
    completedAt: toIsoString(row.completed_at),
    config: asRecord(row.config),
  };
};

const mapRecommendationRow = (row: DbRecommendationRow): RecommendationRow => {
  return {
    id: toNumber(row.id),
    agentRunId: row.agent_run_id === null ? null : toNumber(row.agent_run_id),
    insightId: row.insight_id === null ? null : toNumber(row.insight_id),
    recommendationType: row.recommendation_type,
    targetAutomationId: row.target_automation_id,
    status: row.status,
    changePayload: asRecord(row.change_payload),
    createdAt: toIsoString(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: toIsoString(row.updated_at) ?? new Date(0).toISOString(),
    insightRank: row.insight_rank === null ? null : toNumber(row.insight_rank),
    insightTitle: row.insight_title,
    insightSummary: row.insight_summary,
    runUuid: row.run_uuid,
    runType: row.run_type,
    runStartedAt: toIsoString(row.run_started_at),
  };
};

const mapEventRow = (row: DbEventRow): RecentEventRow => {
  return {
    id: toNumber(row.id),
    eventTime: toIsoString(row.event_time) ?? new Date(0).toISOString(),
    eventType: row.event_type,
    domain: row.domain,
    entityId: row.entity_id,
    service: row.service,
    contextId: row.context_id,
    parentContextId: row.parent_context_id,
    userId: row.user_id,
    collectorInstance: row.collector_instance,
    payloadPreview: row.payload_preview,
  };
};

const readReportType = (value: unknown): 'llm_analysis' | 'daily_home_summary' | null => {
  if (value === 'llm_analysis' || value === 'daily_home_summary') {
    return value;
  }
  return null;
};

const readRecommendationStatus = (value: unknown): 'accepted' | 'rejected' | null => {
  if (value === 'accepted' || value === 'rejected') {
    return value;
  }
  return null;
};

const readEnvironmentSnapshotType = (value: unknown): EnvironmentSnapshotType | null => {
  if (
    value === 'automation' ||
    value === 'script' ||
    value === 'scene' ||
    value === 'blueprint' ||
    value === 'device' ||
    value === 'service' ||
    value === 'integration' ||
    value === 'addon'
  ) {
    return value;
  }
  return null;
};

const isEnvironmentInventoryType = (
  value: EnvironmentSnapshotType,
): value is Extract<EnvironmentSnapshotType, 'device' | 'service' | 'integration' | 'addon'> => {
  return value === 'device' || value === 'service' || value === 'integration' || value === 'addon';
};

const toActionOperationResponse = (operation: ReturnType<ActionRunner['start']>): ActionAcceptedResponse => {
  return { operation };
};

const loadIndexHtml = async (config: UiConfig): Promise<string> => {
  const indexPath = join(config.webDistDir, 'index.html');
  const raw = await readFile(indexPath, 'utf8');
  return raw.replace('__UI_DEFAULT_POLL_MS_VALUE__', String(config.defaultPollIntervalMs));
};

export const createServer = async (options: CreateServerOptions): Promise<FastifyInstance> => {
  const app = Fastify({ logger: false });

  registerApiBasicAuth(app, {
    username: options.config.basicAuthUsername,
    password: options.config.basicAuthPassword,
  });

  const indexHtml = await loadIndexHtml(options.config);

  await app.register(fastifyStatic, {
    root: options.config.webDistDir,
    index: false,
    decorateReply: false,
  });

  app.get('/api/overview', async () => {
    const [latestEventResult, countResult, runsResult, recommendationCountsResult, dailySummaryResult] =
      await Promise.all([
        options.db.query<{ latest_event_time: DbTimestamp | null }>(
          `SELECT MAX(event_time) AS latest_event_time FROM events`,
        ),
        options.db.query<DbCountRow>(
          `
          SELECT
            COUNT(*) FILTER (WHERE event_time >= NOW() - INTERVAL '5 minutes') AS events_5m,
            COUNT(*) FILTER (WHERE event_time >= NOW() - INTERVAL '1 hour') AS events_1h,
            COUNT(*) FILTER (WHERE event_time >= NOW() - INTERVAL '24 hours') AS events_24h
          FROM events
        `,
        ),
        options.db.query<DbRunRow>(
          `
          SELECT DISTINCT ON (run_type)
            id,
            run_uuid,
            run_type,
            status,
            window_start,
            window_end,
            started_at,
            completed_at,
            config
          FROM agent_runs
          ORDER BY run_type, started_at DESC
        `,
        ),
        options.db.query<{ status: string; count: string | number }>(
          `SELECT status, COUNT(*)::bigint AS count FROM recommendations GROUP BY status`,
        ),
        options.db.query<DbDailySummaryRow>(
          `
          SELECT
            ar.id AS report_id,
            ar.report_json->>'targetDay' AS target_day,
            CASE
              WHEN jsonb_typeof(ar.report_json->'anomalies') = 'array' THEN jsonb_array_length(ar.report_json->'anomalies')
              ELSE 0
            END AS anomaly_count,
            ar.published_at
          FROM analysis_results ar
          JOIN agent_runs runs
            ON runs.id = ar.agent_run_id
          WHERE runs.run_type = 'daily_home_summary'
          ORDER BY ar.published_at DESC
          LIMIT 1
        `,
        ),
      ]);

    const countsRow = countResult.rows[0];
    const recommendationCounts = recommendationCountsResult.rows.reduce<Record<string, number>>((acc, row) => {
      acc[row.status] = toNumber(row.count);
      return acc;
    }, {});

    const latestDailySummary = dailySummaryResult.rows[0];

    const response: OverviewResponse = {
      latestCollectorEventAt: toIsoString(latestEventResult.rows[0]?.latest_event_time ?? null),
      ingestion: {
        events5m: countsRow ? toNumber(countsRow.events_5m) : 0,
        events1h: countsRow ? toNumber(countsRow.events_1h) : 0,
        events24h: countsRow ? toNumber(countsRow.events_24h) : 0,
      },
      latestRunsByType: runsResult.rows.map((row) => {
        return {
          id: toNumber(row.id),
          runType: row.run_type,
          status: row.status,
          startedAt: toIsoString(row.started_at) ?? new Date(0).toISOString(),
          completedAt: toIsoString(row.completed_at),
        };
      }),
      recommendationCounts,
      latestDailySummary: {
        reportId: latestDailySummary ? toNumber(latestDailySummary.report_id) : null,
        targetDay: latestDailySummary?.target_day ?? null,
        anomalyCount: latestDailySummary ? toNumber(latestDailySummary.anomaly_count) : 0,
        publishedAt: latestDailySummary ? toIsoString(latestDailySummary.published_at) : null,
      },
    };

    return response;
  });

  app.get('/api/runs', async (request) => {
    const query = request.query as Record<string, unknown>;
    const limit = clampLimit(query.limit, 50, 200);
    const runType = asString(query.runType);
    const status = asString(query.status);

    const whereClauses: string[] = [];
    const params: unknown[] = [];

    if (runType) {
      params.push(runType);
      whereClauses.push(`run_type = $${params.length}`);
    }

    if (status) {
      params.push(status);
      whereClauses.push(`status = $${params.length}`);
    }

    params.push(limit);

    const sql = `
      SELECT
        id,
        run_uuid,
        run_type,
        status,
        window_start,
        window_end,
        started_at,
        completed_at,
        config
      FROM agent_runs
      ${whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : ''}
      ORDER BY started_at DESC
      LIMIT $${params.length}
    `;

    const result = await options.db.query<DbRunRow>(sql, params);

    return {
      runs: result.rows.map(mapRunRow),
    };
  });

  app.get('/api/recommendations', async (request) => {
    const query = request.query as Record<string, unknown>;
    const limit = clampLimit(query.limit, 100, 300);
    const status = asString(query.status);

    const params: unknown[] = [];
    const where: string[] = [];

    if (status) {
      params.push(status);
      where.push(`r.status = $${params.length}`);
    }

    params.push(limit);

    const sql = `
      SELECT
        r.id,
        r.agent_run_id,
        r.insight_id,
        r.recommendation_type,
        r.target_automation_id,
        r.status,
        r.change_payload,
        r.created_at,
        r.updated_at,
        i.rank AS insight_rank,
        i.title AS insight_title,
        i.summary AS insight_summary,
        runs.run_uuid,
        runs.run_type,
        runs.started_at AS run_started_at
      FROM recommendations r
      LEFT JOIN insights i
        ON i.id = r.insight_id
      LEFT JOIN agent_runs runs
        ON runs.id = r.agent_run_id
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY r.created_at DESC
      LIMIT $${params.length}
    `;

    const result = await options.db.query<DbRecommendationRow>(sql, params);

    return {
      recommendations: result.rows.map(mapRecommendationRow),
    };
  });

  app.get('/api/reports/latest', async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const reportType = readReportType(query.type);

    if (!reportType) {
      return reply.code(400).send({ error: "type must be 'llm_analysis' or 'daily_home_summary'" });
    }

    const runType = reportType;

    const result = await options.db.query<DbReportRow>(
      `
        SELECT
          ar.id AS analysis_result_id,
          ar.agent_run_id,
          runs.run_uuid,
          ar.published_at,
          ar.report_markdown,
          ar.report_json
        FROM analysis_results ar
        JOIN agent_runs runs
          ON runs.id = ar.agent_run_id
        WHERE runs.run_type = $1
        ORDER BY ar.published_at DESC
        LIMIT 1
      `,
      [runType],
    );

    const row = result.rows[0];
    if (!row) {
      return reply.code(204).send();
    }

    const response: LatestReportResponse = {
      reportType,
      analysisResultId: toNumber(row.analysis_result_id),
      agentRunId: row.agent_run_id === null ? null : toNumber(row.agent_run_id),
      runUuid: row.run_uuid,
      publishedAt: toIsoString(row.published_at) ?? new Date(0).toISOString(),
      markdown: row.report_markdown,
      payload: asRecord(row.report_json),
    };

    return response;
  });

  app.get('/api/events/recent', async (request) => {
    const query = request.query as Record<string, unknown>;
    const limit = clampLimit(query.limit, 200, 500);

    const result = await options.db.query<DbEventRow>(
      `
        SELECT
          id,
          event_time,
          event_type,
          domain,
          entity_id,
          service,
          context_id,
          parent_context_id,
          user_id,
          collector_instance,
          LEFT(CAST(data AS text), 1200) AS payload_preview
        FROM events
        ORDER BY event_time DESC
        LIMIT $1
      `,
      [limit],
    );

    return {
      events: result.rows.map(mapEventRow),
    };
  });

  app.get('/api/anomalies/recent', async (request) => {
    const query = request.query as Record<string, unknown>;
    const limit = clampLimit(query.limit, 30, 100);

    const result = await options.db.query<DbAnomalyRow>(
      `
        SELECT
          ar.id AS analysis_result_id,
          runs.run_uuid,
          ar.report_json->>'targetDay' AS target_day,
          ar.published_at,
          anomaly.metric,
          anomaly.value,
          anomaly.baseline_mean,
          anomaly.delta,
          anomaly.z_score
        FROM analysis_results ar
        JOIN agent_runs runs
          ON runs.id = ar.agent_run_id
        CROSS JOIN LATERAL (
          SELECT
            item->>'metric' AS metric,
            NULLIF(item->>'value', '')::double precision AS value,
            NULLIF(item->>'baselineMean', '')::double precision AS baseline_mean,
            NULLIF(item->>'delta', '')::double precision AS delta,
            NULLIF(item->>'zScore', '')::double precision AS z_score
          FROM jsonb_array_elements(
            CASE
              WHEN jsonb_typeof(ar.report_json->'anomalies') = 'array' THEN ar.report_json->'anomalies'
              ELSE '[]'::jsonb
            END
          ) AS item
        ) AS anomaly
        WHERE runs.run_type = 'daily_home_summary'
          AND anomaly.metric IS NOT NULL
        ORDER BY ar.published_at DESC
        LIMIT $1
      `,
      [limit],
    );

    const anomalies: AnomalyCard[] = result.rows.map((row) => {
      return {
        analysisResultId: toNumber(row.analysis_result_id),
        runUuid: row.run_uuid,
        targetDay: row.target_day,
        publishedAt: toIsoString(row.published_at) ?? new Date(0).toISOString(),
        metric: row.metric,
        value: toNumber(row.value),
        baselineMean: toNumber(row.baseline_mean),
        delta: toNumber(row.delta),
        zScore: row.z_score === null ? null : toNumber(row.z_score),
      };
    });

    return { anomalies };
  });

  app.get('/api/resource-usage/latest', async () => {
    const result = await options.db.query<DbUsageRow>(
      `
        WITH latest_per_type AS (
          SELECT usage_type, MAX(captured_at) AS captured_at
          FROM ha_usage_snapshots
          WHERE usage_type IN ('energy', 'water', 'gas', 'power')
          GROUP BY usage_type
        )
        SELECT
          snap.usage_type,
          snap.entity_id,
          snap.reading_numeric,
          snap.reading_text,
          snap.unit,
          snap.metadata,
          snap.captured_at
        FROM ha_usage_snapshots snap
        JOIN latest_per_type latest
          ON latest.usage_type = snap.usage_type
         AND latest.captured_at = snap.captured_at
        ORDER BY snap.usage_type ASC, snap.entity_id ASC
      `,
    );

    const response: ResourceUsageResponse = {
      capturedAt: null,
      byType: {
        energy: [],
        water: [],
        gas: [],
        power: [],
      },
    };

    for (const row of result.rows) {
      const usageType = row.usage_type;
      if (usageType !== 'energy' && usageType !== 'water' && usageType !== 'gas' && usageType !== 'power') {
        continue;
      }

      const capturedAt = toIsoString(row.captured_at) ?? new Date(0).toISOString();
      if (!response.capturedAt || capturedAt > response.capturedAt) {
        response.capturedAt = capturedAt;
      }

      response.byType[usageType].push({
        entityId: row.entity_id,
        readingNumeric: row.reading_numeric,
        readingText: row.reading_text,
        unit: row.unit,
        metadata: asRecord(row.metadata),
        capturedAt,
      });
    }

    return response;
  });

  app.get('/api/snapshots/automations/current', async (request): Promise<AutomationSnapshotsResponse> => {
    const query = request.query as Record<string, unknown>;
    const limit = clampLimit(query.limit, 200, 500);
    const search = asString(query.search);

    const latestResult = await options.db.query<{ captured_at: DbTimestamp | null }>(
      `SELECT MAX(captured_at) AS captured_at FROM automation_snapshots`,
    );

    const latestCapturedAtRaw = latestResult.rows[0]?.captured_at ?? null;
    const latestCapturedAt = toIsoString(latestCapturedAtRaw);
    if (!latestCapturedAtRaw || !latestCapturedAt) {
      return {
        capturedAt: null,
        total: 0,
        snapshots: [],
      };
    }

    const whereClauses = ['captured_at = $1', `automation_id LIKE 'automation.%'`];
    const whereParams: unknown[] = [latestCapturedAtRaw];

    if (search) {
      whereParams.push(`%${search}%`);
      whereClauses.push(`(automation_id ILIKE $${whereParams.length} OR COALESCE(alias, '') ILIKE $${whereParams.length})`);
    }

    const totalResult = await options.db.query<{ total_count: string | number }>(
      `
        SELECT COUNT(*)::bigint AS total_count
        FROM automation_snapshots
        WHERE ${whereClauses.join(' AND ')}
      `,
      whereParams,
    );

    const rowParams = [...whereParams, limit];
    const result = await options.db.query<DbAutomationSnapshotRow>(
      `
        SELECT
          id,
          automation_id,
          alias,
          is_enabled,
          trigger_config,
          action_config,
          conditions_config,
          metadata,
          captured_at,
          created_at
        FROM automation_snapshots
        WHERE ${whereClauses.join(' AND ')}
        ORDER BY COALESCE(NULLIF(alias, ''), automation_id), automation_id
        LIMIT $${rowParams.length}
      `,
      rowParams,
    );

    return {
      capturedAt: latestCapturedAt,
      total: toNumber(totalResult.rows[0]?.total_count ?? 0),
      snapshots: result.rows.map((row) => {
        return {
          id: toNumber(row.id),
          automationId: row.automation_id,
          alias: row.alias,
          isEnabled: row.is_enabled,
          triggerConfig: asArray(row.trigger_config),
          actionConfig: asArray(row.action_config),
          conditionsConfig: asArray(row.conditions_config),
          metadata: asRecord(row.metadata),
          capturedAt: toIsoString(row.captured_at) ?? latestCapturedAt,
          createdAt: toIsoString(row.created_at) ?? latestCapturedAt,
        };
      }),
    };
  });

  app.get('/api/snapshots/environment/current', async (request, reply): Promise<EnvironmentSnapshotsResponse | FastifyReply> => {
    const query = request.query as Record<string, unknown>;
    const snapshotType = readEnvironmentSnapshotType(query.type);
    const limit = clampLimit(query.limit, 200, 500);
    const search = asString(query.search);

    if (!snapshotType) {
      return reply.code(400).send({
        error: "type must be one of: automation, script, scene, blueprint, device, service, integration, addon",
      });
    }
    if (isEnvironmentInventoryType(snapshotType)) {
      const latestResult = await options.db.query<{ captured_at: DbTimestamp | null }>(
        `
          SELECT MAX(captured_at) AS captured_at
          FROM ha_environment_snapshots
          WHERE snapshot_type = $1
        `,
        [snapshotType],
      );

      const latestCapturedAtRaw = latestResult.rows[0]?.captured_at ?? null;
      const latestCapturedAt = toIsoString(latestCapturedAtRaw);
      if (!latestCapturedAtRaw || !latestCapturedAt) {
        return {
          snapshotType,
          capturedAt: null,
          total: 0,
          snapshots: [],
        };
      }

      const whereClauses = ['snapshot_type = $1', 'captured_at = $2'];
      const whereParams: unknown[] = [snapshotType, latestCapturedAtRaw];

      if (search) {
        whereParams.push(`%${search}%`);
        whereClauses.push(`(resource_id ILIKE $${whereParams.length} OR COALESCE(label, '') ILIKE $${whereParams.length})`);
      }

      const totalResult = await options.db.query<{ total_count: string | number }>(
        `
          SELECT COUNT(*)::bigint AS total_count
          FROM ha_environment_snapshots
          WHERE ${whereClauses.join(' AND ')}
        `,
        whereParams,
      );

      const rowParams = [...whereParams, limit];
      const result = await options.db.query<DbEnvironmentSnapshotRow>(
        `
          SELECT
            id,
            snapshot_type,
            resource_id,
            label,
            metadata,
            captured_at,
            created_at
          FROM ha_environment_snapshots
          WHERE ${whereClauses.join(' AND ')}
          ORDER BY COALESCE(NULLIF(label, ''), resource_id), resource_id
          LIMIT $${rowParams.length}
        `,
        rowParams,
      );

      return {
        snapshotType,
        capturedAt: latestCapturedAt,
        total: toNumber(totalResult.rows[0]?.total_count ?? 0),
        snapshots: result.rows.map((row) => {
          return {
            id: toNumber(row.id),
            snapshotType: row.snapshot_type,
            resourceId: row.resource_id,
            label: row.label,
            metadata: asRecord(row.metadata),
            capturedAt: toIsoString(row.captured_at) ?? latestCapturedAt,
            createdAt: toIsoString(row.created_at) ?? latestCapturedAt,
          };
        }),
      };
    }

    const latestResult = await options.db.query<{ captured_at: DbTimestamp | null }>(
      `
        SELECT MAX(captured_at) AS captured_at
        FROM automation_snapshots
        WHERE ${AUTOMATION_SNAPSHOT_TYPE_SQL} = $1
      `,
      [snapshotType],
    );

    const latestCapturedAtRaw = latestResult.rows[0]?.captured_at ?? null;
    const latestCapturedAt = toIsoString(latestCapturedAtRaw);
    if (!latestCapturedAtRaw || !latestCapturedAt) {
      return {
        snapshotType,
        capturedAt: null,
        total: 0,
        snapshots: [],
      };
    }

    const whereClauses = [`${AUTOMATION_SNAPSHOT_TYPE_SQL} = $1`, 'captured_at = $2'];
    const whereParams: unknown[] = [snapshotType, latestCapturedAtRaw];

    if (search) {
      whereParams.push(`%${search}%`);
      whereClauses.push(
        `(automation_id ILIKE $${whereParams.length} OR COALESCE(NULLIF(alias, ''), '') ILIKE $${whereParams.length} OR COALESCE(metadata->>'blueprintPath', '') ILIKE $${whereParams.length})`,
      );
    }

    const totalResult = await options.db.query<{ total_count: string | number }>(
      `
        SELECT COUNT(*)::bigint AS total_count
        FROM automation_snapshots
        WHERE ${whereClauses.join(' AND ')}
      `,
      whereParams,
    );

    const rowParams = [...whereParams, limit];
    const result = await options.db.query<DbEnvironmentSnapshotRow>(
      `
        SELECT
          id,
          ${AUTOMATION_SNAPSHOT_TYPE_SQL} AS snapshot_type,
          CASE
            WHEN ${AUTOMATION_SNAPSHOT_TYPE_SQL} = 'blueprint'
              THEN COALESCE(NULLIF(metadata->>'blueprintPath', ''), automation_id)
            ELSE automation_id
          END AS resource_id,
          alias AS label,
          metadata,
          captured_at,
          created_at
        FROM automation_snapshots
        WHERE ${whereClauses.join(' AND ')}
        ORDER BY COALESCE(NULLIF(alias, ''), automation_id), automation_id
        LIMIT $${rowParams.length}
      `,
      rowParams,
    );

    return {
      snapshotType,
      capturedAt: latestCapturedAt,
      total: toNumber(totalResult.rows[0]?.total_count ?? 0),
      snapshots: result.rows.map((row) => {
        return {
          id: toNumber(row.id),
          snapshotType: row.snapshot_type,
          resourceId: row.resource_id,
          label: row.label,
          metadata: asRecord(row.metadata),
          capturedAt: toIsoString(row.captured_at) ?? latestCapturedAt,
          createdAt: toIsoString(row.created_at) ?? latestCapturedAt,
        };
      }),
    };
  });

  app.get('/api/snapshots/entities/current', async (request): Promise<EntitySnapshotsResponse> => {
    const query = request.query as Record<string, unknown>;
    const limit = clampLimit(query.limit, 200, 500);
    const search = asString(query.search);
    const domain = asString(query.domain);

    const whereClauses: string[] = [];
    const params: unknown[] = [];

    if (search) {
      params.push(`%${search}%`);
      whereClauses.push(`(entity_id ILIKE $${params.length} OR COALESCE(state, '') ILIKE $${params.length})`);
    }

    if (domain) {
      params.push(domain);
      whereClauses.push(`LOWER(COALESCE(domain, '')) = LOWER($${params.length})`);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const totalResult = await options.db.query<{ total_count: string | number }>(
      `
        WITH ranked AS (
          SELECT
            entity_id,
            ROW_NUMBER() OVER (PARTITION BY entity_id ORDER BY captured_at DESC, id DESC) AS row_number
          FROM entity_snapshots
          ${whereSql}
        )
        SELECT COUNT(*)::bigint AS total_count
        FROM ranked
        WHERE row_number = 1
      `,
      params,
    );

    const rowParams = [...params, limit];
    const result = await options.db.query<DbEntitySnapshotRow>(
      `
        WITH ranked AS (
          SELECT
            id,
            entity_id,
            state,
            domain,
            attributes,
            context_id,
            captured_at,
            source_event_id,
            created_at,
            ROW_NUMBER() OVER (PARTITION BY entity_id ORDER BY captured_at DESC, id DESC) AS row_number
          FROM entity_snapshots
          ${whereSql}
        )
        SELECT
          id,
          entity_id,
          state,
          domain,
          attributes,
          context_id,
          captured_at,
          source_event_id,
          created_at
        FROM ranked
        WHERE row_number = 1
        ORDER BY captured_at DESC, entity_id ASC
        LIMIT $${rowParams.length}
      `,
      rowParams,
    );

    let latestCapturedAt: string | null = null;
    const snapshots = result.rows.map((row) => {
      const capturedAt = toIsoString(row.captured_at) ?? new Date(0).toISOString();
      if (!latestCapturedAt || capturedAt > latestCapturedAt) {
        latestCapturedAt = capturedAt;
      }

      return {
        id: toNumber(row.id),
        entityId: row.entity_id,
        state: row.state,
        domain: row.domain,
        attributes: asRecord(row.attributes),
        contextId: row.context_id,
        capturedAt,
        sourceEventId: row.source_event_id === null ? null : toNumber(row.source_event_id),
        createdAt: toIsoString(row.created_at) ?? capturedAt,
      };
    });

    return {
      total: toNumber(totalResult.rows[0]?.total_count ?? 0),
      latestCapturedAt,
      snapshots,
    };
  });

  app.get('/api/health', async (): Promise<HealthResponse> => {
    const result = await options.db.query<DbHealthRow>(`SELECT NOW() AS db_time, version() AS db_version`);
    const row = result.rows[0];

    return {
      ok: true,
      serverTime: new Date().toISOString(),
      dbTime: row ? toIsoString(row.db_time) : null,
      dbConnected: Boolean(row),
      version: options.config.buildVersion,
    };
  });

  const runAction = (kind: 'run-analysis' | 'run-daily-summary' | 'run-automation-snapshots' | 'run-retention') => {
    return async (_: FastifyRequest, reply: FastifyReply) => {
      return reply.code(202).send(toActionOperationResponse(options.actionRunner.start(kind)));
    };
  };

  app.post('/api/actions/run-analysis', { handler: runAction('run-analysis') });
  app.post('/api/actions/run-daily-summary', { handler: runAction('run-daily-summary') });
  app.post('/api/actions/run-automation-snapshots', { handler: runAction('run-automation-snapshots') });
  app.post('/api/actions/run-retention', { handler: runAction('run-retention') });

  app.get('/api/actions/:id', async (request, reply) => {
    const params = request.params as { id?: string };
    const operationId = params.id?.trim();

    if (!operationId) {
      return reply.code(400).send({ error: 'action id is required' });
    }

    const operation = options.actionRunner.get(operationId);
    if (!operation) {
      return reply.code(404).send({ error: 'action not found' });
    }

    return { operation };
  });

  app.patch('/api/recommendations/:id', async (request, reply) => {
    const params = request.params as { id?: string };
    const recommendationId = Number(params.id);

    if (!Number.isFinite(recommendationId) || recommendationId <= 0) {
      return reply.code(400).send({ error: 'recommendation id must be a positive number' });
    }

    const body = request.body as Record<string, unknown>;
    const nextStatus = readRecommendationStatus(body?.status);

    if (!nextStatus) {
      return reply.code(400).send({ error: "status must be 'accepted' or 'rejected'" });
    }

    const existingResult = await options.db.query<{ status: string }>(
      `SELECT status FROM recommendations WHERE id = $1`,
      [recommendationId],
    );
    const existing = existingResult.rows[0];

    if (!existing) {
      return reply.code(404).send({ error: 'recommendation not found' });
    }

    if (existing.status !== 'proposed') {
      return reply.code(409).send({
        error: `recommendation ${recommendationId} is already '${existing.status}' and cannot be changed`,
      });
    }

    const updateResult = await options.db.query<DbRecommendationRow>(
      `
        WITH updated AS (
          UPDATE recommendations
          SET status = $1,
              updated_at = NOW()
          WHERE id = $2
          RETURNING *
        )
        SELECT
          updated.id,
          updated.agent_run_id,
          updated.insight_id,
          updated.recommendation_type,
          updated.target_automation_id,
          updated.status,
          updated.change_payload,
          updated.created_at,
          updated.updated_at,
          insights.rank AS insight_rank,
          insights.title AS insight_title,
          insights.summary AS insight_summary,
          runs.run_uuid,
          runs.run_type,
          runs.started_at AS run_started_at
        FROM updated
        LEFT JOIN insights
          ON insights.id = updated.insight_id
        LEFT JOIN agent_runs runs
          ON runs.id = updated.agent_run_id
      `,
      [nextStatus, recommendationId],
    );

    const row = updateResult.rows[0];
    if (!row) {
      return reply.code(500).send({ error: 'failed to update recommendation' });
    }

    const response: RecommendationUpdateResponse = {
      recommendation: mapRecommendationRow(row),
    };

    return response;
  });

  app.get('/', async (_, reply) => {
    return reply.type('text/html').send(indexHtml);
  });

  app.setNotFoundHandler(async (request, reply) => {
    const requestUrl = request.raw.url || request.url;
    if (requestUrl.startsWith('/api/')) {
      return reply.code(404).send({ error: 'Not found' });
    }

    return reply.type('text/html').send(indexHtml);
  });

  return app;
};
