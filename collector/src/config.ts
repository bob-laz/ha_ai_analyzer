import os from 'node:os';

export type OverflowPolicy = 'drop_newest' | 'drop_oldest' | 'retry';

const csvToSet = (value: string): Set<string> =>
  new Set(
    value
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean),
  );

const csvToArray = (value: string): string[] =>
  value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

const parseNumber = (value: string | undefined, fallback: number): number => {
  if (value === undefined) {
    return fallback;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return fallback;
  }

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseOverflowPolicy = (value: string | undefined): OverflowPolicy => {
  if (value === 'drop_oldest' || value === 'retry' || value === 'drop_newest') {
    return value;
  }
  return 'drop_newest';
};

export type CollectorConfig = {
  databaseUrl: string;
  haWsUrl: string;
  haToken: string;
  eventTypes: string[];
  domainAllowlist: Set<string>;
  domainExcludelist: Set<string>;
  batchSize: number;
  flushIntervalSeconds: number;
  reconnectInitialSeconds: number;
  reconnectMaxSeconds: number;
  reconnectJitterRatio: number;
  maxBufferedEvents: number;
  overflowPolicy: OverflowPolicy;
  retryBackpressureDelayMs: number;
  collectorInstanceId: string;
  logLevel: string;
};

export const loadConfig = (): CollectorConfig => ({
  databaseUrl: process.env.DATABASE_URL ?? 'postgresql://ha_ai:ha_ai_dev_password@localhost:5432/ha_ai',
  haWsUrl: process.env.HA_WS_URL ?? 'ws://localhost:8123/api/websocket',
  haToken: process.env.HA_TOKEN ?? '',
  eventTypes: csvToArray(process.env.EVENT_TYPES ?? 'state_changed,call_service'),
  domainAllowlist: csvToSet(process.env.DOMAIN_ALLOWLIST ?? ''),
  domainExcludelist: csvToSet(process.env.DOMAIN_EXCLUDELIST ?? ''),
  batchSize: parseNumber(process.env.BATCH_SIZE, 250),
  flushIntervalSeconds: parseNumber(process.env.FLUSH_INTERVAL_SECONDS, 2),
  reconnectInitialSeconds: parseNumber(process.env.RECONNECT_INITIAL_SECONDS, 1),
  reconnectMaxSeconds: parseNumber(process.env.RECONNECT_MAX_SECONDS, 30),
  reconnectJitterRatio: parseNumber(process.env.RECONNECT_JITTER_RATIO, 0.2),
  maxBufferedEvents: parseNumber(process.env.MAX_BUFFERED_EVENTS, 5000),
  overflowPolicy: parseOverflowPolicy(process.env.OVERFLOW_POLICY),
  retryBackpressureDelayMs: parseNumber(process.env.RETRY_BACKPRESSURE_DELAY_MS, 250),
  collectorInstanceId: process.env.COLLECTOR_INSTANCE_ID ?? os.hostname(),
  logLevel: process.env.LOG_LEVEL ?? 'info',
});
