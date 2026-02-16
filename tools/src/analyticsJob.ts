import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { type AnalysisRunnerConfig, runAnalysis } from './analysisRunner.js';
import { createToolsPool } from './db.js';
import { OpenAIProvider } from './llm/openaiProvider.js';
import type { LLMProvider } from './llm/provider.js';

type ScheduleTime = {
  hour: number;
  minute: number;
};

type AnalyticsRuntimeConfig = {
  databaseUrl: string;
  outputDir: string;
  timezone: string;
  scheduleTime: ScheduleTime;
  llmProviderName: string;
  llmModel: string;
  llmTimeoutMs: number;
  llmRetryMaxAttempts: number;
  haNotification: {
    enabled: boolean;
    haHttpUrl: string | null;
    haToken: string;
    title: string;
    notificationId: string;
    maxMessageChars: number;
    requestTimeoutMs: number;
  };
  analysis: AnalysisRunnerConfig;
};

export const ANALYSIS_RUN_LOCK_KEY = 82814431;

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

export const deriveHaHttpUrlFromWsUrl = (haWsUrl: string | undefined): string | null => {
  if (!haWsUrl) {
    return null;
  }

  try {
    const parsed = new URL(haWsUrl);
    if (parsed.protocol === 'ws:') {
      parsed.protocol = 'http:';
    } else if (parsed.protocol === 'wss:') {
      parsed.protocol = 'https:';
    }

    if (parsed.pathname.endsWith('/api/websocket')) {
      parsed.pathname = parsed.pathname.slice(0, -'/api/websocket'.length) || '/';
    }

    return parsed.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
};

const parseScheduleTime = (raw: string | undefined): ScheduleTime => {
  const value = (raw ?? '03:00').trim();
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) {
    throw new Error(`LLM_SCHEDULE_TIME must be HH:MM (24h), received '${value}'`);
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`LLM_SCHEDULE_TIME is out of range: '${value}'`);
  }

  return { hour, minute };
};

const zonedParts = (
  date: Date,
  timezone: string,
): { year: number; month: number; day: number; hour: number; minute: number } => {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });

  const parts = formatter.formatToParts(date);
  const year = Number(parts.find((part) => part.type === 'year')?.value);
  const month = Number(parts.find((part) => part.type === 'month')?.value);
  const day = Number(parts.find((part) => part.type === 'day')?.value);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value);

  if ([year, month, day, hour, minute].some((value) => !Number.isFinite(value))) {
    throw new Error(`Unable to resolve timezone parts for '${timezone}'`);
  }

  return { year, month, day, hour, minute };
};

const zonedDateTimeToUtc = (
  local: { year: number; month: number; day: number; hour: number; minute: number },
  timezone: string,
): Date => {
  const targetUtcLike = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, 0, 0);
  let guessUtc = targetUtcLike;

  for (let i = 0; i < 4; i += 1) {
    const guessParts = zonedParts(new Date(guessUtc), timezone);
    const guessUtcLike = Date.UTC(
      guessParts.year,
      guessParts.month - 1,
      guessParts.day,
      guessParts.hour,
      guessParts.minute,
      0,
      0,
    );

    guessUtc += targetUtcLike - guessUtcLike;
  }

  return new Date(guessUtc);
};

export const computeNextScheduledRunAt = (now: Date, scheduleTime: ScheduleTime, timezone: string): Date => {
  const nowLocal = zonedParts(now, timezone);

  const candidateTodayUtc = zonedDateTimeToUtc(
    {
      year: nowLocal.year,
      month: nowLocal.month,
      day: nowLocal.day,
      hour: scheduleTime.hour,
      minute: scheduleTime.minute,
    },
    timezone,
  );

  if (candidateTodayUtc.getTime() > now.getTime()) {
    return candidateTodayUtc;
  }

  const tomorrowUtcBase = new Date(Date.UTC(nowLocal.year, nowLocal.month - 1, nowLocal.day + 1, 0, 0, 0, 0));
  return zonedDateTimeToUtc(
    {
      year: tomorrowUtcBase.getUTCFullYear(),
      month: tomorrowUtcBase.getUTCMonth() + 1,
      day: tomorrowUtcBase.getUTCDate(),
      hour: scheduleTime.hour,
      minute: scheduleTime.minute,
    },
    timezone,
  );
};

const truncate = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) {
    return value;
  }
  const suffix = '\n\n[Truncated]';
  const retained = Math.max(0, maxChars - suffix.length);
  return `${value.slice(0, retained)}${suffix}`;
};

const readString = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const readRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
};

export const buildHomeAssistantNotificationMessage = (
  result: Awaited<ReturnType<typeof runAnalysis>>,
  maxChars: number,
): string => {
  const report = readRecord(result.reportPayload);
  const summary = readString(report.summary) ?? '(no summary)';
  const window = readRecord(report.window);
  const rankedInsights = Array.isArray(report.rankedInsights) ? report.rankedInsights : [];
  const changes = Array.isArray(report.proposedAutomationChanges) ? report.proposedAutomationChanges : [];

  const lines: string[] = [];
  lines.push(`# Home Assistant AI Analysis`);
  lines.push('');
  lines.push(`- Run: ${result.runUuid}`);
  const windowStart = readString(window.start);
  const windowEnd = readString(window.end);
  const windowTz = readString(window.timezone);
  if (windowStart && windowEnd) {
    lines.push(`- Window: ${windowStart} to ${windowEnd}${windowTz ? ` (${windowTz})` : ''}`);
  }
  lines.push('');
  lines.push('## Summary');
  lines.push(summary);
  lines.push('');
  lines.push('## Top Insights');

  if (rankedInsights.length === 0) {
    lines.push('- None');
  } else {
    for (let i = 0; i < Math.min(5, rankedInsights.length); i += 1) {
      const item = readRecord(rankedInsights[i]);
      const rank = typeof item.rank === 'number' ? item.rank : i + 1;
      const title = readString(item.title) ?? 'Untitled insight';
      const confidence = typeof item.confidence === 'number' ? ` (confidence ${item.confidence.toFixed(2)})` : '';
      lines.push(`${rank}. ${title}${confidence}`);
    }
  }

  lines.push('');
  lines.push('## Proposed Changes');
  if (changes.length === 0) {
    lines.push('- None');
  } else {
    for (let i = 0; i < Math.min(5, changes.length); i += 1) {
      const item = readRecord(changes[i]);
      const automationId = readString(item.automationId) ?? 'unknown_automation';
      const changeType = readString(item.changeType) ?? 'change';
      const reasoning = readString(item.reasoning) ?? 'No reasoning provided';
      lines.push(`- ${automationId}: ${changeType}`);
      lines.push(`  ${reasoning}`);
    }
  }

  return truncate(lines.join('\n'), maxChars);
};

export const publishHomeAssistantNotification = async (
  result: Awaited<ReturnType<typeof runAnalysis>>,
  config: AnalyticsRuntimeConfig['haNotification'],
): Promise<boolean> => {
  if (!config.enabled) {
    return false;
  }

  if (!config.haHttpUrl || !config.haToken) {
    console.warn('skipping HA analysis notification because HA_HTTP_URL/HA_TOKEN is not configured');
    return false;
  }

  const url = `${config.haHttpUrl}/api/services/persistent_notification/create`;
  const message = buildHomeAssistantNotificationMessage(result, config.maxMessageChars);
  const payload = {
    title: config.title,
    message,
    notification_id: config.notificationId,
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.haToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `HA notification request failed: ${response.status} ${response.statusText}${body ? ` (${body})` : ''}`,
      );
    }

    return true;
  } finally {
    clearTimeout(timeoutId);
  }
};

const toBool = (value: unknown): boolean => {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 't' || normalized === 'true' || normalized === '1';
  }
  return false;
};

export const withAnalysisRunLock = async (
  pool: ReturnType<typeof createToolsPool>,
  run: () => Promise<void>,
): Promise<boolean> => {
  const lockResult = await pool.query<{ locked: boolean | string }>('SELECT pg_try_advisory_lock($1) AS locked', [
    ANALYSIS_RUN_LOCK_KEY,
  ]);
  const isLocked = toBool(lockResult.rows[0]?.locked);

  if (!isLocked) {
    return false;
  }

  try {
    await run();
    return true;
  } finally {
    await pool.query('SELECT pg_advisory_unlock($1)', [ANALYSIS_RUN_LOCK_KEY]);
  }
};

const resolveRuntimeConfig = (): AnalyticsRuntimeConfig => {
  const timezone = process.env.LLM_SCHEDULE_TIMEZONE ?? process.env.ANALYTICS_TIMEZONE ?? 'UTC';
  const haHttpUrl =
    process.env.HA_HTTP_URL?.trim() ||
    deriveHaHttpUrlFromWsUrl(process.env.HA_WS_URL) ||
    'http://homeassistant.local:8123';
  const haToken = process.env.HA_TOKEN?.trim() ?? '';

  return {
    databaseUrl: process.env.DATABASE_URL ?? 'postgresql://ha_ai:ha_ai_dev_password@localhost:5432/ha_ai',
    outputDir: process.env.REPORT_OUTPUT_DIR ?? '/tmp/ha-ai-reports',
    timezone,
    scheduleTime: parseScheduleTime(process.env.LLM_SCHEDULE_TIME),
    llmProviderName: (process.env.LLM_PROVIDER ?? 'openai').trim().toLowerCase(),
    llmModel: (process.env.LLM_MODEL ?? 'gpt-4.1-mini').trim(),
    llmTimeoutMs: parsePositiveInt(process.env.LLM_REQUEST_TIMEOUT_MS, 30_000),
    llmRetryMaxAttempts: parsePositiveInt(process.env.LLM_RETRY_MAX_ATTEMPTS, 3),
    haNotification: {
      enabled: parseBoolean(process.env.LLM_HA_NOTIFICATION_ENABLED, true),
      haHttpUrl,
      haToken,
      title: (process.env.LLM_HA_NOTIFICATION_TITLE ?? 'Home Assistant AI Analysis').trim(),
      notificationId: (process.env.LLM_HA_NOTIFICATION_ID ?? 'ha_ai_llm_analysis_latest').trim(),
      maxMessageChars: parsePositiveInt(process.env.LLM_HA_NOTIFICATION_MAX_CHARS, 6000),
      requestTimeoutMs: parsePositiveInt(process.env.LLM_HA_NOTIFICATION_REQUEST_TIMEOUT_MS, 10_000),
    },
    analysis: {
      runType: 'llm_analysis',
      timezone,
      windowHours: parsePositiveInt(process.env.LLM_ANALYSIS_WINDOW_HOURS, 24),
      maxInsights: parsePositiveInt(process.env.LLM_ANALYSIS_MAX_INSIGHTS, 5),
      maxTopChanges: parsePositiveInt(process.env.LLM_MAX_TOP_CHANGES, 20),
      maxTraceContexts: parsePositiveInt(process.env.LLM_MAX_TRACE_CONTEXTS, 10),
      maxEventsPerContext: parsePositiveInt(process.env.LLM_MAX_EVENTS_PER_CONTEXT, 60),
      traceMaxDepth: parsePositiveInt(process.env.LLM_TRACE_MAX_DEPTH, 6),
      maxEnvironmentItemsPerType: parsePositiveInt(process.env.LLM_MAX_ENVIRONMENT_ITEMS_PER_TYPE, 50),
      maxResourceUsageItemsPerType: parsePositiveInt(process.env.LLM_MAX_RESOURCE_USAGE_ITEMS_PER_TYPE, 20),
    },
  };
};

const createProvider = (config: AnalyticsRuntimeConfig): LLMProvider => {
  if (config.llmProviderName !== 'openai') {
    throw new Error(`Unsupported LLM_PROVIDER '${config.llmProviderName}'. Supported providers: openai`);
  }

  return new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY ?? '',
    model: config.llmModel,
    timeoutMs: config.llmTimeoutMs,
    retryMaxAttempts: config.llmRetryMaxAttempts,
    baseUrl: process.env.OPENAI_BASE_URL,
  });
};

const runOnce = async (
  pool: ReturnType<typeof createToolsPool>,
  provider: LLMProvider,
  runtime: AnalyticsRuntimeConfig,
): Promise<void> => {
  const lockAcquired = await withAnalysisRunLock(pool, async () => {
    const result = await runAnalysis(pool, provider, runtime.analysis);

    await mkdir(runtime.outputDir, { recursive: true });
    const outputPath = join(runtime.outputDir, `llm-analysis-${result.runUuid}.json`);
    await writeFile(
      outputPath,
      JSON.stringify(
        {
          agentRunId: result.agentRunId,
          runUuid: result.runUuid,
          analysisResultId: result.analysisResultId,
          payload: result.reportPayload,
        },
        null,
        2,
      ),
      'utf8',
    );

    console.info('analysis run completed', {
      runUuid: result.runUuid,
      agentRunId: result.agentRunId,
      analysisResultId: result.analysisResultId,
      outputPath,
    });

    try {
      const published = await publishHomeAssistantNotification(result, runtime.haNotification);
      if (published) {
        console.info('published HA persistent notification for analysis run', {
          runUuid: result.runUuid,
          notificationId: runtime.haNotification.notificationId,
        });
      }
    } catch (error) {
      console.warn('failed to publish HA analysis notification', {
        runUuid: result.runUuid,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  if (!lockAcquired) {
    console.warn('analysis run skipped because another run currently holds advisory lock', {
      lockKey: ANALYSIS_RUN_LOCK_KEY,
    });
  }
};

const runScheduler = async (
  pool: ReturnType<typeof createToolsPool>,
  provider: LLMProvider,
  runtime: AnalyticsRuntimeConfig,
): Promise<void> => {
  while (true) {
    const now = new Date();
    const nextRunAt = computeNextScheduledRunAt(now, runtime.scheduleTime, runtime.timezone);
    const waitMs = Math.max(0, nextRunAt.getTime() - now.getTime());

    console.info('next scheduled analysis run planned', {
      now: now.toISOString(),
      nextRunAt: nextRunAt.toISOString(),
      waitMs,
      timezone: runtime.timezone,
      scheduleTime: `${String(runtime.scheduleTime.hour).padStart(2, '0')}:${String(runtime.scheduleTime.minute).padStart(2, '0')}`,
    });

    await sleep(waitMs);

    try {
      await runOnce(pool, provider, runtime);
    } catch (error) {
      console.error('scheduled analysis run failed', {
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      });
    }
  }
};

const parseMode = (args: string[]): 'once' | 'schedule' => {
  const knownFlags = new Set(['--once', '--schedule']);
  for (const arg of args) {
    if (!knownFlags.has(arg)) {
      throw new Error(`Unknown analyticsJob argument '${arg}'. Supported flags: --once, --schedule`);
    }
  }

  if (args.includes('--once')) {
    return 'once';
  }

  return 'schedule';
};

export const runAnalyticsJob = async (args: string[] = process.argv.slice(2)): Promise<void> => {
  const runtime = resolveRuntimeConfig();
  const provider = createProvider(runtime);
  const pool = createToolsPool(runtime.databaseUrl);

  const mode = parseMode(args);

  try {
    if (mode === 'once') {
      await runOnce(pool, provider, runtime);
      return;
    }

    await runScheduler(pool, provider, runtime);
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
  void runAnalyticsJob().catch((error) => {
    console.error('analytics job failed', {
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
    process.exitCode = 1;
  });
}
