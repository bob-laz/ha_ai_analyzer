import type { QueryResultRow } from 'pg';

import type { SqlQueryable } from './db.js';

export type TimeWindow = {
  start: string;
  end: string;
};

export type StubResponse = {
  status: 'stub';
  function: string;
  todo: string;
};

export type DailySummary = {
  day: string;
  timezone: string;
  totalEvents: number;
  uniqueEntities: number;
  stateChanges: number;
  serviceCalls: number;
};

export type TopChangeRow = {
  subjectType: 'entity' | 'service';
  subjectId: string;
  currentCount: number;
  previousCount: number;
  delta: number;
};

export type TopChangesResult = {
  window: TimeWindow;
  limit: number;
  rows: TopChangeRow[];
};

export type TraceContextEvent = {
  id: number;
  eventTime: string;
  eventType: string;
  domain: string | null;
  entityId: string | null;
  service: string | null;
  contextId: string | null;
  parentContextId: string | null;
  userId: string | null;
  data: Record<string, unknown>;
};

export type TraceContextResult = {
  requestedContextId: string;
  rootContextId: string | null;
  contextDepth: Array<{ contextId: string; depth: number }>;
  relatedContextMetadata: Array<{
    contextId: string;
    rootContextId: string | null;
    relatedContextIds: string[];
    metadata: Record<string, unknown>;
  }>;
  events: TraceContextEvent[];
};

export type PublishReportResult = {
  status: 'published' | 'stub';
  analysisResultId?: number;
  publishedAt?: string;
  markdownPreview: string;
  payloadKeys: string[];
};

const toNumber = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const ensureIsoDate = (date: string): string => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`date must be YYYY-MM-DD, received: ${date}`);
  }
  return date;
};

const ensureWindow = (window: TimeWindow): { start: Date; end: Date } => {
  const start = new Date(window.start);
  const end = new Date(window.end);

  if (Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf())) {
    throw new Error(`window.start and window.end must be valid ISO datetimes: ${JSON.stringify(window)}`);
  }

  if (end <= start) {
    throw new Error('window.end must be greater than window.start');
  }

  return { start, end };
};

export const GET_DAILY_SUMMARY_SQL = `
WITH bounds AS (
  SELECT
    ($1::date::timestamp AT TIME ZONE $2) AS start_utc,
    (($1::date + INTERVAL '1 day')::timestamp AT TIME ZONE $2) AS end_utc
)
SELECT
  $1::date::text AS day,
  $2::text AS timezone,
  COUNT(*)::bigint AS total_events,
  COUNT(DISTINCT entity_id)::bigint AS unique_entities,
  COUNT(*) FILTER (WHERE event_type = 'state_changed')::bigint AS state_changes,
  COUNT(*) FILTER (WHERE event_type = 'call_service')::bigint AS service_calls
FROM events e
JOIN bounds b
  ON e.event_time >= b.start_utc
 AND e.event_time < b.end_utc
`;

export const GET_TOP_CHANGES_SQL = `
WITH params AS (
  SELECT
    $1::timestamptz AS window_start,
    $2::timestamptz AS window_end,
    ($1::timestamptz - ($3::text || ' seconds')::interval) AS previous_start
),
current_subjects AS (
  SELECT 'entity'::text AS subject_type, e.entity_id AS subject_id
  FROM events e
  CROSS JOIN params p
  WHERE e.event_time >= p.window_start
    AND e.event_time < p.window_end
    AND e.entity_id IS NOT NULL
  UNION ALL
  SELECT 'service'::text AS subject_type, CONCAT(COALESCE(e.domain, 'unknown'), '.', e.service) AS subject_id
  FROM events e
  CROSS JOIN params p
  WHERE e.event_time >= p.window_start
    AND e.event_time < p.window_end
    AND e.service IS NOT NULL
),
previous_subjects AS (
  SELECT 'entity'::text AS subject_type, e.entity_id AS subject_id
  FROM events e
  CROSS JOIN params p
  WHERE e.event_time >= p.previous_start
    AND e.event_time < p.window_start
    AND e.entity_id IS NOT NULL
  UNION ALL
  SELECT 'service'::text AS subject_type, CONCAT(COALESCE(e.domain, 'unknown'), '.', e.service) AS subject_id
  FROM events e
  CROSS JOIN params p
  WHERE e.event_time >= p.previous_start
    AND e.event_time < p.window_start
    AND e.service IS NOT NULL
),
current_counts AS (
  SELECT subject_type, subject_id, COUNT(*)::bigint AS current_count
  FROM current_subjects
  GROUP BY subject_type, subject_id
),
previous_counts AS (
  SELECT subject_type, subject_id, COUNT(*)::bigint AS previous_count
  FROM previous_subjects
  GROUP BY subject_type, subject_id
)
SELECT
  COALESCE(c.subject_type, p.subject_type) AS subject_type,
  COALESCE(c.subject_id, p.subject_id) AS subject_id,
  COALESCE(c.current_count, 0)::bigint AS current_count,
  COALESCE(p.previous_count, 0)::bigint AS previous_count,
  (COALESCE(c.current_count, 0) - COALESCE(p.previous_count, 0))::bigint AS delta
FROM current_counts c
FULL OUTER JOIN previous_counts p
  ON c.subject_type = p.subject_type
 AND c.subject_id = p.subject_id
ORDER BY
  ABS(COALESCE(c.current_count, 0) - COALESCE(p.previous_count, 0)) DESC,
  (COALESCE(c.current_count, 0) - COALESCE(p.previous_count, 0)) DESC,
  COALESCE(c.current_count, 0) DESC,
  COALESCE(c.subject_type, p.subject_type) ASC,
  COALESCE(c.subject_id, p.subject_id) ASC
LIMIT $4
`;

export const TRACE_CONTEXT_GRAPH_SQL = `
WITH RECURSIVE edges AS (
  SELECT e.context_id AS source_context_id, e.parent_context_id AS target_context_id
  FROM events e
  WHERE e.context_id IS NOT NULL
    AND e.parent_context_id IS NOT NULL
  UNION
  SELECT e.parent_context_id AS source_context_id, e.context_id AS target_context_id
  FROM events e
  WHERE e.context_id IS NOT NULL
    AND e.parent_context_id IS NOT NULL
),
graph AS (
  SELECT $1::text AS context_id, 0::int AS depth
  UNION ALL
  SELECT edge.target_context_id AS context_id, g.depth + 1
  FROM graph g
  JOIN edges edge ON edge.source_context_id = g.context_id
  WHERE g.depth < $2
),
dedup AS (
  SELECT context_id, MIN(depth) AS depth
  FROM graph
  GROUP BY context_id
)
SELECT context_id, depth
FROM dedup
ORDER BY depth ASC, context_id ASC
`;

const TRACE_CONTEXT_EVENTS_SQL = `
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
  data
FROM events
WHERE context_id = ANY($1::text[])
ORDER BY event_time ASC, id ASC
`;

const TRACE_CONTEXT_METADATA_SQL = `
SELECT
  context_id,
  root_context_id,
  related_context_ids,
  metadata
FROM trace_contexts
WHERE context_id = ANY($1::text[])
ORDER BY context_id ASC
`;

const PUBLISH_REPORT_SQL = `
INSERT INTO analysis_results (
  agent_run_id,
  report_markdown,
  report_json
)
VALUES ($1, $2, $3::jsonb)
RETURNING id, published_at
`;

export const getDailySummary = async (
  date: string,
  db?: SqlQueryable,
  timezone = 'UTC',
): Promise<DailySummary | StubResponse> => {
  const normalizedDate = ensureIsoDate(date);

  if (!db) {
    return {
      status: 'stub',
      function: 'getDailySummary',
      todo: 'Provide a SqlQueryable to execute GET_DAILY_SUMMARY_SQL.',
    };
  }

  const result = await db.query<{
    day: string;
    timezone: string;
    total_events: string | number;
    unique_entities: string | number;
    state_changes: string | number;
    service_calls: string | number;
  }>(GET_DAILY_SUMMARY_SQL, [normalizedDate, timezone]);

  const row = result.rows[0];
  if (!row) {
    return {
      day: normalizedDate,
      timezone,
      totalEvents: 0,
      uniqueEntities: 0,
      stateChanges: 0,
      serviceCalls: 0,
    };
  }

  return {
    day: row.day,
    timezone: row.timezone,
    totalEvents: toNumber(row.total_events),
    uniqueEntities: toNumber(row.unique_entities),
    stateChanges: toNumber(row.state_changes),
    serviceCalls: toNumber(row.service_calls),
  };
};

export const getTopChanges = async (
  window: TimeWindow,
  limit = 10,
  db?: SqlQueryable,
): Promise<TopChangesResult | StubResponse> => {
  const { start, end } = ensureWindow(window);

  if (!db) {
    return {
      status: 'stub',
      function: 'getTopChanges',
      todo: 'Provide a SqlQueryable to execute GET_TOP_CHANGES_SQL.',
    };
  }

  const windowSeconds = Math.floor((end.getTime() - start.getTime()) / 1000);

  const result = await db.query<{
    subject_type: 'entity' | 'service';
    subject_id: string;
    current_count: string | number;
    previous_count: string | number;
    delta: string | number;
  }>(GET_TOP_CHANGES_SQL, [start.toISOString(), end.toISOString(), windowSeconds, limit]);

  return {
    window,
    limit,
    rows: result.rows.map((row) => ({
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      currentCount: toNumber(row.current_count),
      previousCount: toNumber(row.previous_count),
      delta: toNumber(row.delta),
    })),
  };
};

export const traceContext = async (
  contextId: string,
  db?: SqlQueryable,
  maxDepth = 6,
): Promise<TraceContextResult | StubResponse> => {
  if (!contextId) {
    throw new Error('contextId is required');
  }

  if (!db) {
    return {
      status: 'stub',
      function: 'traceContext',
      todo: 'Provide a SqlQueryable to execute trace context graph queries.',
    };
  }

  const contextGraph = await db.query<{ context_id: string; depth: number | string }>(TRACE_CONTEXT_GRAPH_SQL, [
    contextId,
    maxDepth,
  ]);

  const contextDepth = contextGraph.rows.map((row) => ({
    contextId: row.context_id,
    depth: toNumber(row.depth),
  }));

  const contextIds = [...new Set(contextDepth.map((entry) => entry.contextId))];
  if (!contextIds.includes(contextId)) {
    contextIds.unshift(contextId);
    contextDepth.unshift({ contextId, depth: 0 });
  }

  const eventsResult = await db.query<{
    id: number | string;
    event_time: string;
    event_type: string;
    domain: string | null;
    entity_id: string | null;
    service: string | null;
    context_id: string | null;
    parent_context_id: string | null;
    user_id: string | null;
    data: QueryResultRow;
  }>(TRACE_CONTEXT_EVENTS_SQL, [contextIds]);

  const metadataResult = await db.query<{
    context_id: string;
    root_context_id: string | null;
    related_context_ids: unknown;
    metadata: QueryResultRow | null;
  }>(TRACE_CONTEXT_METADATA_SQL, [contextIds]);

  const rootContextId =
    metadataResult.rows.find((row) => row.root_context_id)?.root_context_id ??
    contextDepth.sort((a, b) => a.depth - b.depth)[0]?.contextId ??
    contextId;

  return {
    requestedContextId: contextId,
    rootContextId,
    contextDepth,
    relatedContextMetadata: metadataResult.rows.map((row) => ({
      contextId: row.context_id,
      rootContextId: row.root_context_id,
      relatedContextIds: Array.isArray(row.related_context_ids) ? (row.related_context_ids as string[]) : [],
      metadata: row.metadata ?? {},
    })),
    events: eventsResult.rows.map((row) => ({
      id: toNumber(row.id),
      eventTime: row.event_time,
      eventType: row.event_type,
      domain: row.domain,
      entityId: row.entity_id,
      service: row.service,
      contextId: row.context_id,
      parentContextId: row.parent_context_id,
      userId: row.user_id,
      data: (row.data ?? {}) as Record<string, unknown>,
    })),
  };
};

export const publishReport = async (
  markdown: string,
  jsonPayload: Record<string, unknown>,
  db?: SqlQueryable,
  agentRunId: number | null = null,
): Promise<PublishReportResult> => {
  const markdownPreview = markdown.slice(0, 160);
  const payloadKeys = Object.keys(jsonPayload).sort();

  if (!db) {
    return {
      status: 'stub',
      markdownPreview,
      payloadKeys,
    };
  }

  const result = await db.query<{ id: number | string; published_at: string }>(PUBLISH_REPORT_SQL, [
    agentRunId,
    markdown,
    JSON.stringify(jsonPayload),
  ]);

  const row = result.rows[0];

  return {
    status: 'published',
    analysisResultId: row ? toNumber(row.id) : undefined,
    publishedAt: row?.published_at,
    markdownPreview,
    payloadKeys,
  };
};
