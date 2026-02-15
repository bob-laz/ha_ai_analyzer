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

export type EntityTimelineGranularity = 'minute' | 'hour' | 'day';

export type EntityTimelineBucket = {
  bucketStart: string;
  totalEvents: number;
  stateChanges: number;
  serviceCalls: number;
};

export type EntityTimelineResult = {
  entityId: string;
  window: TimeWindow;
  granularity: EntityTimelineGranularity;
  buckets: EntityTimelineBucket[];
};

export type CorrelationRow = {
  subjectType: 'entity' | 'service';
  subjectId: string;
  overlapContexts: number;
  overlapEvents: number;
  correlationScore: number;
};

export type CorrelationResult = {
  entityId: string;
  window: TimeWindow;
  topN: number;
  targetContextCount: number;
  rows: CorrelationRow[];
};

export type AutomationSnapshot = {
  automationId: string;
  alias: string | null;
  isEnabled: boolean | null;
  triggerConfig: unknown[];
  actionConfig: unknown[];
  conditionsConfig: unknown[];
  metadata: Record<string, unknown>;
  capturedAt: string;
};

export type AutomationSnapshotResult = {
  automationId: string;
  found: boolean;
  snapshot: AutomationSnapshot | null;
  recentActivity: {
    windowHours: number;
    totalEvents: number;
    stateChanges: number;
    serviceCalls: number;
    lastEventAt: string | null;
  };
};

export type ListAutomationsFilter = {
  search?: string;
  isEnabled?: boolean;
  limit?: number;
  offset?: number;
};

export type AutomationListItem = {
  automationId: string;
  alias: string | null;
  isEnabled: boolean | null;
  capturedAt: string;
  metadata: Record<string, unknown>;
};

export type ListAutomationsResult = {
  filterApplied: {
    search: string | null;
    isEnabled: boolean | null;
    limit: number;
    offset: number;
  };
  rows: AutomationListItem[];
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

const toNullableBoolean = (value: unknown): boolean | null => {
  if (typeof value === 'boolean') {
    return value;
  }
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', 't', '1'].includes(normalized)) {
      return true;
    }
    if (['false', 'f', '0'].includes(normalized)) {
      return false;
    }
  }
  return null;
};

const toRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
};

const toArray = (value: unknown): unknown[] => {
  if (Array.isArray(value)) {
    return value;
  }
  return [];
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

const ensurePositiveLimit = (value: number, fallback: number, maxValue: number): number => {
  const parsed = Math.floor(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, maxValue);
};

const normalizeGranularity = (granularity: EntityTimelineGranularity): EntityTimelineGranularity => {
  if (granularity === 'minute' || granularity === 'hour' || granularity === 'day') {
    return granularity;
  }
  throw new Error(`granularity must be one of minute|hour|day, received '${String(granularity)}'`);
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

const ENTITY_TIMELINE_SQL = `
SELECT
  date_trunc($4::text, e.event_time) AS bucket_start,
  COUNT(*)::bigint AS total_events,
  COUNT(*) FILTER (WHERE e.event_type = 'state_changed')::bigint AS state_changes,
  COUNT(*) FILTER (WHERE e.event_type = 'call_service')::bigint AS service_calls
FROM events e
WHERE e.event_time >= $1::timestamptz
  AND e.event_time < $2::timestamptz
  AND e.entity_id = $3
GROUP BY bucket_start
ORDER BY bucket_start ASC
`;

const CORRELATE_SQL = `
WITH target_contexts AS (
  SELECT DISTINCT e.context_id
  FROM events e
  WHERE e.event_time >= $1::timestamptz
    AND e.event_time < $2::timestamptz
    AND e.entity_id = $3
    AND e.context_id IS NOT NULL
),
target_stats AS (
  SELECT COUNT(*)::bigint AS context_count FROM target_contexts
),
candidates AS (
  SELECT
    'entity'::text AS subject_type,
    e.entity_id AS subject_id,
    e.context_id
  FROM events e
  WHERE e.event_time >= $1::timestamptz
    AND e.event_time < $2::timestamptz
    AND e.context_id IN (SELECT context_id FROM target_contexts)
    AND e.entity_id IS NOT NULL
    AND e.entity_id <> $3
  UNION ALL
  SELECT
    'service'::text AS subject_type,
    CONCAT(COALESCE(e.domain, 'unknown'), '.', e.service) AS subject_id,
    e.context_id
  FROM events e
  WHERE e.event_time >= $1::timestamptz
    AND e.event_time < $2::timestamptz
    AND e.context_id IN (SELECT context_id FROM target_contexts)
    AND e.service IS NOT NULL
),
aggregated AS (
  SELECT
    c.subject_type,
    c.subject_id,
    COUNT(*)::bigint AS overlap_events,
    COUNT(DISTINCT c.context_id)::bigint AS overlap_contexts
  FROM candidates c
  GROUP BY c.subject_type, c.subject_id
)
SELECT
  a.subject_type,
  a.subject_id,
  a.overlap_contexts,
  a.overlap_events,
  CASE
    WHEN t.context_count = 0 THEN 0
    ELSE (a.overlap_contexts::numeric / t.context_count::numeric)
  END AS correlation_score,
  t.context_count
FROM aggregated a
CROSS JOIN target_stats t
ORDER BY a.overlap_contexts DESC, a.overlap_events DESC, a.subject_type ASC, a.subject_id ASC
LIMIT $4
`;

const AUTOMATION_SNAPSHOT_SQL = `
SELECT
  automation_id,
  alias,
  is_enabled,
  trigger_config,
  action_config,
  conditions_config,
  metadata,
  captured_at
FROM automation_snapshots
WHERE automation_id = $1
ORDER BY captured_at DESC, id DESC
LIMIT 1
`;

const AUTOMATION_RECENT_ACTIVITY_SQL = `
SELECT
  COUNT(*)::bigint AS total_events,
  COUNT(*) FILTER (WHERE event_type = 'state_changed')::bigint AS state_changes,
  COUNT(*) FILTER (WHERE event_type = 'call_service')::bigint AS service_calls,
  MAX(event_time) AS last_event_at
FROM events
WHERE event_time >= NOW() - ($2::int || ' hours')::interval
  AND (
    entity_id = $1
    OR (
      event_type = 'call_service'
      AND COALESCE(data -> 'service_data' ->> 'entity_id', '') = $1
    )
  )
`;

const LIST_AUTOMATIONS_SQL = `
WITH latest AS (
  SELECT DISTINCT ON (automation_id)
    automation_id,
    alias,
    is_enabled,
    metadata,
    captured_at
  FROM automation_snapshots
  ORDER BY automation_id, captured_at DESC, id DESC
)
SELECT
  automation_id,
  alias,
  is_enabled,
  metadata,
  captured_at
FROM latest
WHERE ($1::text IS NULL OR automation_id ILIKE '%' || $1 || '%' OR COALESCE(alias, '') ILIKE '%' || $1 || '%')
  AND ($2::boolean IS NULL OR is_enabled IS NOT DISTINCT FROM $2)
ORDER BY captured_at DESC, automation_id ASC
LIMIT $3 OFFSET $4
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

export const entityTimeline = async (
  entityId: string,
  start: string,
  end: string,
  granularity: EntityTimelineGranularity,
  db?: SqlQueryable,
): Promise<EntityTimelineResult | StubResponse> => {
  if (!entityId) {
    throw new Error('entityId is required');
  }
  const window = { start, end };
  ensureWindow(window);
  const normalizedGranularity = normalizeGranularity(granularity);

  if (!db) {
    return {
      status: 'stub',
      function: 'entityTimeline',
      todo: 'Provide a SqlQueryable to execute ENTITY_TIMELINE_SQL.',
    };
  }

  const result = await db.query<{
    bucket_start: string;
    total_events: string | number;
    state_changes: string | number;
    service_calls: string | number;
  }>(ENTITY_TIMELINE_SQL, [start, end, entityId, normalizedGranularity]);

  return {
    entityId,
    window,
    granularity: normalizedGranularity,
    buckets: result.rows.map((row) => ({
      bucketStart: row.bucket_start,
      totalEvents: toNumber(row.total_events),
      stateChanges: toNumber(row.state_changes),
      serviceCalls: toNumber(row.service_calls),
    })),
  };
};

export const correlate = async (
  entityId: string,
  window: TimeWindow,
  topN = 5,
  db?: SqlQueryable,
): Promise<CorrelationResult | StubResponse> => {
  if (!entityId) {
    throw new Error('entityId is required');
  }
  ensureWindow(window);
  const normalizedTopN = ensurePositiveLimit(topN, 5, 100);

  if (!db) {
    return {
      status: 'stub',
      function: 'correlate',
      todo: 'Provide a SqlQueryable to execute CORRELATE_SQL.',
    };
  }

  const result = await db.query<{
    subject_type: 'entity' | 'service';
    subject_id: string;
    overlap_contexts: string | number;
    overlap_events: string | number;
    correlation_score: string | number;
    context_count: string | number;
  }>(CORRELATE_SQL, [window.start, window.end, entityId, normalizedTopN]);

  const targetContextCount = toNumber(result.rows[0]?.context_count ?? 0);

  return {
    entityId,
    window,
    topN: normalizedTopN,
    targetContextCount,
    rows: result.rows.map((row) => ({
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      overlapContexts: toNumber(row.overlap_contexts),
      overlapEvents: toNumber(row.overlap_events),
      correlationScore: Number(row.correlation_score),
    })),
  };
};

export const getAutomationSnapshot = async (
  automationId: string,
  db?: SqlQueryable,
): Promise<AutomationSnapshotResult | StubResponse> => {
  if (!automationId) {
    throw new Error('automationId is required');
  }

  if (!db) {
    return {
      status: 'stub',
      function: 'getAutomationSnapshot',
      todo: 'Provide a SqlQueryable to execute automation snapshot queries.',
    };
  }

  const [snapshotResult, activityResult] = await Promise.all([
    db.query<{
      automation_id: string;
      alias: string | null;
      is_enabled: boolean | string | null;
      trigger_config: unknown;
      action_config: unknown;
      conditions_config: unknown;
      metadata: unknown;
      captured_at: string;
    }>(AUTOMATION_SNAPSHOT_SQL, [automationId]),
    db.query<{
      total_events: string | number;
      state_changes: string | number;
      service_calls: string | number;
      last_event_at: string | null;
    }>(AUTOMATION_RECENT_ACTIVITY_SQL, [automationId, 24]),
  ]);

  const snapshotRow = snapshotResult.rows[0];
  const activityRow = activityResult.rows[0];

  return {
    automationId,
    found: Boolean(snapshotRow),
    snapshot: snapshotRow
      ? {
          automationId: snapshotRow.automation_id,
          alias: snapshotRow.alias,
          isEnabled: toNullableBoolean(snapshotRow.is_enabled),
          triggerConfig: toArray(snapshotRow.trigger_config),
          actionConfig: toArray(snapshotRow.action_config),
          conditionsConfig: toArray(snapshotRow.conditions_config),
          metadata: toRecord(snapshotRow.metadata),
          capturedAt: snapshotRow.captured_at,
        }
      : null,
    recentActivity: {
      windowHours: 24,
      totalEvents: toNumber(activityRow?.total_events ?? 0),
      stateChanges: toNumber(activityRow?.state_changes ?? 0),
      serviceCalls: toNumber(activityRow?.service_calls ?? 0),
      lastEventAt: activityRow?.last_event_at ?? null,
    },
  };
};

export const listAutomations = async (
  filter: ListAutomationsFilter = {},
  db?: SqlQueryable,
): Promise<ListAutomationsResult | StubResponse> => {
  const rawSearch = typeof filter.search === 'string' ? filter.search.trim() : '';
  const search = rawSearch.length > 0 ? rawSearch : null;
  const isEnabled = toNullableBoolean(filter.isEnabled);
  const limit = ensurePositiveLimit(filter.limit ?? 50, 50, 200);
  const offset = Math.max(0, Math.floor(filter.offset ?? 0));

  if (!db) {
    return {
      status: 'stub',
      function: 'listAutomations',
      todo: 'Provide a SqlQueryable to execute LIST_AUTOMATIONS_SQL.',
    };
  }

  const result = await db.query<{
    automation_id: string;
    alias: string | null;
    is_enabled: boolean | string | null;
    metadata: unknown;
    captured_at: string;
  }>(LIST_AUTOMATIONS_SQL, [search, isEnabled, limit, offset]);

  return {
    filterApplied: {
      search,
      isEnabled,
      limit,
      offset,
    },
    rows: result.rows.map((row) => ({
      automationId: row.automation_id,
      alias: row.alias,
      isEnabled: toNullableBoolean(row.is_enabled),
      capturedAt: row.captured_at,
      metadata: toRecord(row.metadata),
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
