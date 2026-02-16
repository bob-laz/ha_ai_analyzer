import { afterEach, describe, expect, test } from 'vitest';

import { loadConfig } from '../src/config.js';

const NUMERIC_ENV_KEYS = [
  'BATCH_SIZE',
  'FLUSH_INTERVAL_SECONDS',
  'RECONNECT_INITIAL_SECONDS',
  'RECONNECT_MAX_SECONDS',
  'RECONNECT_JITTER_RATIO',
  'MAX_BUFFERED_EVENTS',
  'RETRY_BACKPRESSURE_DELAY_MS',
] as const;

const CSV_ENV_KEYS = ['EVENT_TYPES', 'DOMAIN_ALLOWLIST', 'DOMAIN_EXCLUDELIST'] as const;
const TRACKED_ENV_KEYS = [...NUMERIC_ENV_KEYS, ...CSV_ENV_KEYS] as const;

const ORIGINAL_ENV = new Map<string, string | undefined>(TRACKED_ENV_KEYS.map((key) => [key, process.env[key]]));

const restoreNumericEnv = (): void => {
  for (const key of TRACKED_ENV_KEYS) {
    const original = ORIGINAL_ENV.get(key);
    if (original === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = original;
  }
};

afterEach(() => {
  restoreNumericEnv();
});

describe('loadConfig numeric parsing', () => {
  test('uses fallback defaults when numeric env vars are missing', () => {
    for (const key of NUMERIC_ENV_KEYS) {
      delete process.env[key];
    }

    const config = loadConfig();
    expect(config.batchSize).toBe(250);
    expect(config.flushIntervalSeconds).toBe(2);
    expect(config.reconnectInitialSeconds).toBe(1);
    expect(config.reconnectMaxSeconds).toBe(30);
    expect(config.reconnectJitterRatio).toBe(0.2);
    expect(config.maxBufferedEvents).toBe(5000);
    expect(config.retryBackpressureDelayMs).toBe(250);
  });

  test('uses fallback defaults when numeric env vars are blank', () => {
    for (const key of NUMERIC_ENV_KEYS) {
      process.env[key] = '   ';
    }

    const config = loadConfig();
    expect(config.batchSize).toBe(250);
    expect(config.flushIntervalSeconds).toBe(2);
    expect(config.reconnectInitialSeconds).toBe(1);
    expect(config.reconnectMaxSeconds).toBe(30);
    expect(config.reconnectJitterRatio).toBe(0.2);
    expect(config.maxBufferedEvents).toBe(5000);
    expect(config.retryBackpressureDelayMs).toBe(250);
  });

  test('normalizes csv/list env values for event and domain filters', () => {
    process.env.EVENT_TYPES = " state_changed CALL_SERVICE 'automation_reloaded' ";
    process.env.DOMAIN_ALLOWLIST = 'automation, Script   LIGHT';
    process.env.DOMAIN_EXCLUDELIST = '"UPDATER" automation';

    const config = loadConfig();
    expect(config.eventTypes).toEqual(['state_changed', 'call_service', 'automation_reloaded']);
    expect([...config.domainAllowlist]).toEqual(['automation', 'script', 'light']);
    expect([...config.domainExcludelist]).toEqual(['updater', 'automation']);
  });
});
