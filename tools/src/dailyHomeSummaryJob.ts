import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import type { Pool, PoolClient } from 'pg';

import { getDailySummary, getTopChanges, publishReport, type TopChangesResult } from './agentTools.js';
import { analysisRepo } from './analysisRepo.js';
import { computeNextScheduledRunAt, deriveHaHttpUrlFromWsUrl } from './analyticsJob.js';
import { createToolsPool } from './db.js';
import type { ResourceUsageSnapshot } from './llm/types.js';

type ScheduleTime = {
  hour: number;
  minute: number;
};

type DailySummaryConfig = {
  databaseUrl: string;
  timezone: string;
  scheduleTime: ScheduleTime;
  targetDayOffset: number;
  baselineDays: number;
  minBaselineDays: number;
  anomalyZscoreThreshold: number;
  anomalyMinDelta: number;
  topChangesLimit: number;
  topSubjectsLimit: number;
  maxResourceUsageItemsPerType: number;
  notification: {
    enabled: boolean;
    haHttpUrl: string | null;
    haToken: string;
    title: string;
    notificationId: string;
    maxMessageChars: number;
    requestTimeoutMs: number;
  };
};

type MetricName = 'totalEvents' | 'uniqueEntities' | 'stateChanges' | 'serviceCalls';

type DailyMetricPoint = {
  day: string;
  totalEvents: number;
  uniqueEntities: number;
  stateChanges: number;
  serviceCalls: number;
};

export type MetricAnomaly = {
  metric: MetricName;
  value: number;
  baselineMean: number;
  baselineStddev: number;
  delta: number;
  zScore: number | null;
};

type SubjectActivityRow = {
  subjectId: string;
  eventCount: number;
};

type DailySummaryRunOutput = {
  targetDay: string;
  targetSummary: DailyMetricPoint;
  baseline: DailyMetricPoint[];
  anomalies: MetricAnomaly[];
  topChanges: TopChangesResult;
  topEntities: SubjectActivityRow[];
  topServices: SubjectActivityRow[];
  resourceUsageSnapshot: ResourceUsageSnapshot | null;
  markdown: string;
  reportPayload: Record<string, unknown>;
  runUuid: string;
  agentRunId: number;
  analysisResultId: number | null;
};

const DAILY_SUMMARY_RUN_LOCK_KEY = 92511039;

const isStubResponse = (value: unknown): value is { status: 'stub'; function: string; todo: string } => {
  return (
    !!value &&
    typeof value === 'object' &&
    'status' in value &&
    (value as { status?: unknown }).status === 'stub' &&
    'function' in value
  );
};

const parseNumber = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined) {
    return fallback;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return fallback;
  }

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parsePositiveInt = (raw: string | undefined, fallback: number): number => {
  const parsed = Math.floor(parseNumber(raw, fallback));
  return parsed > 0 ? parsed : fallback;
};

const parseNonNegativeInt = (raw: string | undefined, fallback: number): number => {
  const parsed = Math.floor(parseNumber(raw, fallback));
  return parsed >= 0 ? parsed : fallback;
};

const parseBoolean = (raw: string | undefined, fallback: boolean): boolean => {
  if (raw === undefined) {
    return fallback;
  }

  const normalized = raw.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }

  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
};

const parseScheduleTime = (raw: string | undefined): ScheduleTime => {
  const value = (raw ?? '00:10').trim();
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) {
    throw new Error(`DAILY_SUMMARY_SCHEDULE_TIME must be HH:MM (24h), received '${value}'`);
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`DAILY_SUMMARY_SCHEDULE_TIME is out of range: '${value}'`);
  }

  return { hour, minute };
};

const dayInTimezone = (date: Date, timezone: string): string => {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  const parts = formatter.formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  if (!year || !month || !day) {
    throw new Error(`Unable to resolve date in timezone '${timezone}'`);
  }
  return `${year}-${month}-${day}`;
};

const shiftDay = (day: string, offsetDays: number): string => {
  const [year, month, date] = day.split('-').map(Number);
  if (!year || !month || !date) {
    throw new Error(`Invalid day value '${day}'`);
  }

  const shifted = new Date(Date.UTC(year, month - 1, date + offsetDays));
  return shifted.toISOString().slice(0, 10);
};

const resolveConfig = (): DailySummaryConfig => {
  const timezone = process.env.DAILY_SUMMARY_SCHEDULE_TIMEZONE ?? process.env.ANALYTICS_TIMEZONE ?? 'UTC';
  const haHttpUrl = process.env.HA_HTTP_URL?.trim() || deriveHaHttpUrlFromWsUrl(process.env.HA_WS_URL);

  return {
    databaseUrl: process.env.DATABASE_URL ?? 'postgresql://ha_ai:ha_ai_dev_password@localhost:5432/ha_ai',
    timezone,
    scheduleTime: parseScheduleTime(process.env.DAILY_SUMMARY_SCHEDULE_TIME),
    targetDayOffset: parseNonNegativeInt(process.env.DAILY_SUMMARY_TARGET_DAY_OFFSET, 1),
    baselineDays: parsePositiveInt(process.env.DAILY_SUMMARY_BASELINE_DAYS, 7),
    minBaselineDays: parsePositiveInt(process.env.DAILY_SUMMARY_MIN_BASELINE_DAYS, 3),
    anomalyZscoreThreshold: parseNumber(process.env.DAILY_SUMMARY_ANOMALY_ZSCORE_THRESHOLD, 2),
    anomalyMinDelta: parsePositiveInt(process.env.DAILY_SUMMARY_ANOMALY_MIN_DELTA, 25),
    topChangesLimit: parsePositiveInt(process.env.DAILY_SUMMARY_TOP_CHANGES_LIMIT, 8),
    topSubjectsLimit: parsePositiveInt(process.env.DAILY_SUMMARY_TOP_SUBJECTS_LIMIT, 5),
    maxResourceUsageItemsPerType: parsePositiveInt(process.env.DAILY_SUMMARY_MAX_RESOURCE_USAGE_ITEMS_PER_TYPE, 5),
    notification: {
      enabled: parseBoolean(process.env.DAILY_SUMMARY_NOTIFICATION_ENABLED, true),
      haHttpUrl,
      haToken: process.env.HA_TOKEN?.trim() ?? '',
      title: (process.env.DAILY_SUMMARY_NOTIFICATION_TITLE ?? 'Daily Home Summary').trim(),
      notificationId: (process.env.DAILY_SUMMARY_NOTIFICATION_ID ?? 'ha_ai_daily_summary_latest').trim(),
      maxMessageChars: parsePositiveInt(process.env.DAILY_SUMMARY_NOTIFICATION_MAX_CHARS, 6000),
      requestTimeoutMs: parsePositiveInt(process.env.DAILY_SUMMARY_NOTIFICATION_REQUEST_TIMEOUT_MS, 10_000),
    },
  };
};

const DAILY_BOUNDS_SQL = `
SELECT
  ($1::date::timestamp AT TIME ZONE $2) AS start_utc,
  (($1::date + INTERVAL '1 day')::timestamp AT TIME ZONE $2) AS end_utc
`;

const TOP_ENTITIES_SQL = `
WITH bounds AS (
  SELECT
    ($1::date::timestamp AT TIME ZONE $2) AS start_utc,
    (($1::date + INTERVAL '1 day')::timestamp AT TIME ZONE $2) AS end_utc
)
SELECT e.entity_id AS subject_id, COUNT(*)::bigint AS event_count
FROM events e
JOIN bounds b
  ON e.event_time >= b.start_utc
 AND e.event_time < b.end_utc
WHERE e.entity_id IS NOT NULL
GROUP BY e.entity_id
ORDER BY event_count DESC, subject_id ASC
LIMIT $3
`;

const TOP_SERVICES_SQL = `
WITH bounds AS (
  SELECT
    ($1::date::timestamp AT TIME ZONE $2) AS start_utc,
    (($1::date + INTERVAL '1 day')::timestamp AT TIME ZONE $2) AS end_utc
)
SELECT CONCAT(COALESCE(e.domain, 'unknown'), '.', e.service) AS subject_id, COUNT(*)::bigint AS event_count
FROM events e
JOIN bounds b
  ON e.event_time >= b.start_utc
 AND e.event_time < b.end_utc
WHERE e.service IS NOT NULL
GROUP BY subject_id
ORDER BY event_count DESC, subject_id ASC
LIMIT $3
`;

const average = (values: number[]): number => {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

const stddev = (values: number[], mean: number): number => {
  if (values.length <= 1) {
    return 0;
  }
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
};

const pickMetric = (point: DailyMetricPoint, metric: MetricName): number => {
  switch (metric) {
    case 'totalEvents':
      return point.totalEvents;
    case 'uniqueEntities':
      return point.uniqueEntities;
    case 'stateChanges':
      return point.stateChanges;
    case 'serviceCalls':
      return point.serviceCalls;
    default:
      return 0;
  }
};

export const detectMetricAnomalies = (
  target: DailyMetricPoint,
  baseline: DailyMetricPoint[],
  config: Pick<DailySummaryConfig, 'minBaselineDays' | 'anomalyZscoreThreshold' | 'anomalyMinDelta'>,
): MetricAnomaly[] => {
  if (baseline.length < config.minBaselineDays) {
    return [];
  }

  const anomalies: MetricAnomaly[] = [];
  const metrics: MetricName[] = ['totalEvents', 'uniqueEntities', 'stateChanges', 'serviceCalls'];
  for (const metric of metrics) {
    const baselineValues = baseline.map((point) => pickMetric(point, metric));
    const baselineMean = average(baselineValues);
    const baselineStddev = stddev(baselineValues, baselineMean);
    const value = pickMetric(target, metric);
    const delta = value - baselineMean;
    const absDelta = Math.abs(delta);

    let zScore: number | null = null;
    if (baselineStddev > 0) {
      zScore = absDelta / baselineStddev;
    } else if (absDelta > 0) {
      zScore = Infinity;
    } else {
      zScore = 0;
    }

    const thresholdMet = zScore !== null && zScore >= config.anomalyZscoreThreshold;
    const deltaMet = absDelta >= config.anomalyMinDelta;

    if (thresholdMet && deltaMet) {
      anomalies.push({
        metric,
        value,
        baselineMean,
        baselineStddev,
        delta,
        zScore,
      });
    }
  }

  return anomalies;
};

const withTransaction = async <T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // noop
    }
    throw error;
  } finally {
    client.release();
  }
};

const formatChange = (value: number): string => {
  if (value > 0) {
    return `+${value.toFixed(0)}`;
  }
  return value.toFixed(0);
};

const buildMarkdown = (
  targetDay: string,
  targetSummary: DailyMetricPoint,
  baseline: DailyMetricPoint[],
  anomalies: MetricAnomaly[],
  topChanges: TopChangesResult,
  topEntities: SubjectActivityRow[],
  topServices: SubjectActivityRow[],
  resourceUsageSnapshot: ResourceUsageSnapshot | null,
): string => {
  const lines: string[] = [];
  lines.push(`# Daily Home Summary (${targetDay})`);
  lines.push('');
  lines.push(`- Total events: ${targetSummary.totalEvents}`);
  lines.push(`- Unique entities: ${targetSummary.uniqueEntities}`);
  lines.push(`- State changes: ${targetSummary.stateChanges}`);
  lines.push(`- Service calls: ${targetSummary.serviceCalls}`);
  lines.push(`- Baseline window: previous ${baseline.length} day(s)`);
  lines.push('');
  lines.push('## Anomalies');
  if (anomalies.length === 0) {
    lines.push('- No anomalies detected against baseline thresholds.');
  } else {
    for (const anomaly of anomalies) {
      lines.push(
        `- ${anomaly.metric}: ${anomaly.value} (baseline ${anomaly.baselineMean.toFixed(1)}, change ${formatChange(anomaly.delta)}, z=${anomaly.zScore === null ? 'n/a' : anomaly.zScore.toFixed(2)})`,
      );
    }
  }

  lines.push('');
  lines.push('## Largest Day-Over-Day Changes');
  if (topChanges.rows.length === 0) {
    lines.push('- No changes found.');
  } else {
    for (const row of topChanges.rows.slice(0, 8)) {
      lines.push(
        `- ${row.subjectType}:${row.subjectId} -> current ${row.currentCount}, previous ${row.previousCount}, delta ${row.delta}`,
      );
    }
  }

  lines.push('');
  lines.push('## Top Entities');
  if (topEntities.length === 0) {
    lines.push('- None');
  } else {
    for (const row of topEntities) {
      lines.push(`- ${row.subjectId}: ${row.eventCount}`);
    }
  }

  lines.push('');
  lines.push('## Top Services');
  if (topServices.length === 0) {
    lines.push('- None');
  } else {
    for (const row of topServices) {
      lines.push(`- ${row.subjectId}: ${row.eventCount}`);
    }
  }

  if (resourceUsageSnapshot) {
    lines.push('');
    lines.push('## Resource Usage Snapshot');
    lines.push(`- Captured at: ${resourceUsageSnapshot.capturedAt}`);
    lines.push(
      `- Counts: energy ${resourceUsageSnapshot.countsByType.energy}, water ${resourceUsageSnapshot.countsByType.water}, gas ${resourceUsageSnapshot.countsByType.gas}, power ${resourceUsageSnapshot.countsByType.power}`,
    );
  }

  return lines.join('\n');
};

const truncate = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) {
    return value;
  }
  const suffix = '\n\n[Truncated]';
  const retained = Math.max(0, maxChars - suffix.length);
  return `${value.slice(0, retained)}${suffix}`;
};

export const buildDailySummaryNotificationMessage = (
  summary: Pick<
    DailySummaryRunOutput,
    'targetDay' | 'targetSummary' | 'anomalies' | 'topEntities' | 'topServices' | 'resourceUsageSnapshot'
  >,
  maxChars: number,
): string => {
  const lines: string[] = [];
  lines.push(`# Daily Home Summary (${summary.targetDay})`);
  lines.push('');
  lines.push(
    `Events ${summary.targetSummary.totalEvents}, state changes ${summary.targetSummary.stateChanges}, service calls ${summary.targetSummary.serviceCalls}, unique entities ${summary.targetSummary.uniqueEntities}.`,
  );
  lines.push('');
  lines.push('## Anomalies');
  if (summary.anomalies.length === 0) {
    lines.push('- None');
  } else {
    for (const anomaly of summary.anomalies.slice(0, 5)) {
      lines.push(`- ${anomaly.metric}: ${anomaly.value} (baseline ${anomaly.baselineMean.toFixed(1)})`);
    }
  }

  lines.push('');
  lines.push('## Top Entities');
  if (summary.topEntities.length === 0) {
    lines.push('- None');
  } else {
    for (const row of summary.topEntities.slice(0, 5)) {
      lines.push(`- ${row.subjectId}: ${row.eventCount}`);
    }
  }

  lines.push('');
  lines.push('## Top Services');
  if (summary.topServices.length === 0) {
    lines.push('- None');
  } else {
    for (const row of summary.topServices.slice(0, 5)) {
      lines.push(`- ${row.subjectId}: ${row.eventCount}`);
    }
  }

  if (summary.resourceUsageSnapshot) {
    lines.push('');
    lines.push('## Utility Sensors');
    lines.push(
      `energy ${summary.resourceUsageSnapshot.countsByType.energy}, water ${summary.resourceUsageSnapshot.countsByType.water}, gas ${summary.resourceUsageSnapshot.countsByType.gas}, power ${summary.resourceUsageSnapshot.countsByType.power}`,
    );
  }

  return truncate(lines.join('\n'), maxChars);
};

const publishNotification = async (
  output: DailySummaryRunOutput,
  config: DailySummaryConfig['notification'],
): Promise<boolean> => {
  if (!config.enabled) {
    return false;
  }

  if (!config.haHttpUrl || !config.haToken) {
    console.warn('skipping daily summary notification because HA_HTTP_URL/HA_TOKEN is not configured');
    return false;
  }

  const message = buildDailySummaryNotificationMessage(
    {
      targetDay: output.targetDay,
      targetSummary: output.targetSummary,
      anomalies: output.anomalies,
      topEntities: output.topEntities,
      topServices: output.topServices,
      resourceUsageSnapshot: output.resourceUsageSnapshot,
    },
    config.maxMessageChars,
  );

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    const response = await fetch(`${config.haHttpUrl}/api/services/persistent_notification/create`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.haToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: config.title,
        message,
        notification_id: config.notificationId,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `HA daily summary notification failed: ${response.status} ${response.statusText}${body ? ` (${body})` : ''}`,
      );
    }

    return true;
  } finally {
    clearTimeout(timeoutId);
  }
};

const queryDailyBounds = async (pool: Pool, day: string, timezone: string): Promise<{ start: string; end: string }> => {
  const result = await pool.query<{ start_utc: string; end_utc: string }>(DAILY_BOUNDS_SQL, [day, timezone]);
  const row = result.rows[0];
  if (!row) {
    throw new Error(`Failed to resolve UTC bounds for day ${day}`);
  }
  return {
    start: row.start_utc,
    end: row.end_utc,
  };
};

const toMetricPoint = (day: string, summary: Awaited<ReturnType<typeof getDailySummary>>): DailyMetricPoint => {
  if (isStubResponse(summary)) {
    throw new Error(`getDailySummary returned stub for ${day}`);
  }

  return {
    day,
    totalEvents: summary.totalEvents,
    uniqueEntities: summary.uniqueEntities,
    stateChanges: summary.stateChanges,
    serviceCalls: summary.serviceCalls,
  };
};

const queryTopSubjects = async (
  pool: Pool,
  sql: string,
  day: string,
  timezone: string,
  limit: number,
): Promise<SubjectActivityRow[]> => {
  const result = await pool.query<{ subject_id: string; event_count: number | string }>(sql, [day, timezone, limit]);
  return result.rows.map((row) => ({
    subjectId: row.subject_id,
    eventCount: Number(row.event_count),
  }));
};

const runDailySummaryPass = async (pool: Pool, config: DailySummaryConfig): Promise<DailySummaryRunOutput> => {
  const now = new Date();
  const referenceDay = dayInTimezone(now, config.timezone);
  const targetDay = shiftDay(referenceDay, -config.targetDayOffset);
  const bounds = await queryDailyBounds(pool, targetDay, config.timezone);

  const run = await analysisRepo.createAgentRun(pool, {
    runType: 'daily_home_summary',
    status: 'running',
    windowStart: bounds.start,
    windowEnd: bounds.end,
    config: {
      timezone: config.timezone,
      targetDay,
      targetDayOffset: config.targetDayOffset,
      baselineDays: config.baselineDays,
      topChangesLimit: config.topChangesLimit,
    },
  });

  try {
    const targetSummary = toMetricPoint(targetDay, await getDailySummary(targetDay, pool, config.timezone));
    const baselineDays: string[] = [];
    for (let i = 1; i <= config.baselineDays; i += 1) {
      baselineDays.push(shiftDay(targetDay, -i));
    }

    const baseline = await Promise.all(
      baselineDays.map(async (day) => toMetricPoint(day, await getDailySummary(day, pool, config.timezone))),
    );
    const anomalies = detectMetricAnomalies(targetSummary, baseline, config);

    const topChangesResult = await getTopChanges(bounds, config.topChangesLimit, pool);
    if (isStubResponse(topChangesResult)) {
      throw new Error('getTopChanges returned stub during daily summary');
    }
    const topChanges = topChangesResult;

    const [topEntities, topServices] = await Promise.all([
      queryTopSubjects(pool, TOP_ENTITIES_SQL, targetDay, config.timezone, config.topSubjectsLimit),
      queryTopSubjects(pool, TOP_SERVICES_SQL, targetDay, config.timezone, config.topSubjectsLimit),
    ]);
    const resourceUsageSnapshot = await analysisRepo.getLatestResourceUsageSnapshot(
      pool,
      config.maxResourceUsageItemsPerType,
    );

    const markdown = buildMarkdown(
      targetDay,
      targetSummary,
      baseline,
      anomalies,
      topChanges,
      topEntities,
      topServices,
      resourceUsageSnapshot,
    );
    const reportPayload: Record<string, unknown> = {
      reportType: 'daily_home_summary',
      runId: run.runUuid,
      targetDay,
      timezone: config.timezone,
      targetSummary,
      baseline,
      anomalies,
      topChanges,
      topEntities,
      topServices,
      resourceUsageSnapshot,
      generatedAt: new Date().toISOString(),
    };

    const persistResult = await withTransaction(pool, async (client) => {
      const published = await publishReport(markdown, reportPayload, client, run.id);
      if (published.status !== 'published') {
        throw new Error('publishReport returned stub while DB client was provided');
      }

      await analysisRepo.completeAgentRun(client, run.id, {
        daily_home_summary: {
          targetDay,
          anomalies: anomalies.length,
          analysis_result_id: published.analysisResultId ?? null,
          completed_at: new Date().toISOString(),
        },
      });

      return {
        analysisResultId: published.analysisResultId ?? null,
      };
    });

    return {
      targetDay,
      targetSummary,
      baseline,
      anomalies,
      topChanges,
      topEntities,
      topServices,
      resourceUsageSnapshot,
      markdown,
      reportPayload,
      runUuid: run.runUuid,
      agentRunId: run.id,
      analysisResultId: persistResult.analysisResultId,
    };
  } catch (error) {
    await analysisRepo.failAgentRun(pool, run.id, {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      failed_at: new Date().toISOString(),
      error_id: crypto.randomUUID(),
    });
    throw error;
  }
};

const withDailySummaryRunLock = async (pool: Pool, run: () => Promise<void>): Promise<boolean> => {
  const result = await pool.query<{ locked: boolean | string }>('SELECT pg_try_advisory_lock($1) AS locked', [
    DAILY_SUMMARY_RUN_LOCK_KEY,
  ]);
  const lockedValue = result.rows[0]?.locked;
  const locked = lockedValue === true || lockedValue === 't' || lockedValue === 'true' || lockedValue === '1';
  if (!locked) {
    return false;
  }

  try {
    await run();
    return true;
  } finally {
    await pool.query('SELECT pg_advisory_unlock($1)', [DAILY_SUMMARY_RUN_LOCK_KEY]);
  }
};

const runOnce = async (pool: Pool, config: DailySummaryConfig): Promise<void> => {
  const lockAcquired = await withDailySummaryRunLock(pool, async () => {
    const output = await runDailySummaryPass(pool, config);
    console.info('daily home summary run completed', {
      runUuid: output.runUuid,
      targetDay: output.targetDay,
      anomalies: output.anomalies.length,
      analysisResultId: output.analysisResultId,
    });

    try {
      const published = await publishNotification(output, config.notification);
      if (published) {
        console.info('published HA persistent notification for daily home summary', {
          runUuid: output.runUuid,
          notificationId: config.notification.notificationId,
        });
      }
    } catch (error) {
      console.warn('failed to publish HA daily summary notification', {
        runUuid: output.runUuid,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  if (!lockAcquired) {
    console.warn('daily home summary run skipped because another run currently holds advisory lock', {
      lockKey: DAILY_SUMMARY_RUN_LOCK_KEY,
    });
  }
};

const runScheduler = async (pool: Pool, config: DailySummaryConfig): Promise<void> => {
  while (true) {
    const now = new Date();
    const nextRunAt = computeNextScheduledRunAt(now, config.scheduleTime, config.timezone);
    const waitMs = Math.max(0, nextRunAt.getTime() - now.getTime());

    console.info('next scheduled daily home summary run planned', {
      now: now.toISOString(),
      nextRunAt: nextRunAt.toISOString(),
      waitMs,
      timezone: config.timezone,
      scheduleTime: `${String(config.scheduleTime.hour).padStart(2, '0')}:${String(config.scheduleTime.minute).padStart(2, '0')}`,
    });

    await sleep(waitMs);

    try {
      await runOnce(pool, config);
    } catch (error) {
      console.error('scheduled daily home summary run failed', {
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      });
    }
  }
};

const parseMode = (args: string[]): 'once' | 'schedule' => {
  const knownFlags = new Set(['--once', '--schedule']);
  for (const arg of args) {
    if (!knownFlags.has(arg)) {
      throw new Error(`Unknown dailyHomeSummaryJob argument '${arg}'. Supported flags: --once, --schedule`);
    }
  }

  if (args.includes('--once')) {
    return 'once';
  }

  return 'schedule';
};

export const runDailyHomeSummaryJob = async (args: string[] = process.argv.slice(2)): Promise<void> => {
  const config = resolveConfig();
  const pool = createToolsPool(config.databaseUrl);
  const mode = parseMode(args);

  try {
    if (mode === 'once') {
      await runOnce(pool, config);
      return;
    }

    await runScheduler(pool, config);
  } finally {
    await pool.end();
  }
};

const isDirectExecution = (): boolean => {
  if (!process.argv[1]) {
    return false;
  }

  return fileURLToPath(import.meta.url) === process.argv[1];
};

if (isDirectExecution()) {
  void runDailyHomeSummaryJob().catch((error) => {
    console.error('daily home summary job failed', {
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
    process.exitCode = 1;
  });
}
