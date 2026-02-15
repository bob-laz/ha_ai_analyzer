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

  return {
    databaseUrl: process.env.DATABASE_URL ?? 'postgresql://ha_ai:ha_ai_dev_password@localhost:5432/ha_ai',
    outputDir: process.env.REPORT_OUTPUT_DIR ?? '/tmp/ha-ai-reports',
    timezone,
    scheduleTime: parseScheduleTime(process.env.LLM_SCHEDULE_TIME),
    llmProviderName: (process.env.LLM_PROVIDER ?? 'openai').trim().toLowerCase(),
    llmModel: (process.env.LLM_MODEL ?? 'gpt-4.1-mini').trim(),
    llmTimeoutMs: parsePositiveInt(process.env.LLM_REQUEST_TIMEOUT_MS, 30_000),
    llmRetryMaxAttempts: parsePositiveInt(process.env.LLM_RETRY_MAX_ATTEMPTS, 3),
    analysis: {
      runType: 'llm_analysis',
      timezone,
      windowHours: parsePositiveInt(process.env.LLM_ANALYSIS_WINDOW_HOURS, 24),
      maxInsights: parsePositiveInt(process.env.LLM_ANALYSIS_MAX_INSIGHTS, 5),
      maxTopChanges: parsePositiveInt(process.env.LLM_MAX_TOP_CHANGES, 20),
      maxTraceContexts: parsePositiveInt(process.env.LLM_MAX_TRACE_CONTEXTS, 10),
      maxEventsPerContext: parsePositiveInt(process.env.LLM_MAX_EVENTS_PER_CONTEXT, 60),
      traceMaxDepth: parsePositiveInt(process.env.LLM_TRACE_MAX_DEPTH, 6),
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
