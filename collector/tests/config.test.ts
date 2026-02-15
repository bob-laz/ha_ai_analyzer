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

const ORIGINAL_ENV = new Map<string, string | undefined>(NUMERIC_ENV_KEYS.map((key) => [key, process.env[key]]));

const restoreNumericEnv = (): void => {
  for (const key of NUMERIC_ENV_KEYS) {
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
});
