import { describe, expect, test, vi } from 'vitest';

import { ANALYSIS_RUN_LOCK_KEY, computeNextScheduledRunAt, withAnalysisRunLock } from '../src/analyticsJob.js';

describe('computeNextScheduledRunAt', () => {
  test('returns same-day schedule when current time is before target', () => {
    const now = new Date('2026-01-02T01:00:00.000Z');
    const next = computeNextScheduledRunAt(now, { hour: 3, minute: 0 }, 'UTC');

    expect(next.toISOString()).toBe('2026-01-02T03:00:00.000Z');
  });

  test('rolls to next day when current time is after target in timezone', () => {
    const now = new Date('2026-01-02T12:00:00.000Z'); // 04:00 in America/Los_Angeles
    const next = computeNextScheduledRunAt(now, { hour: 3, minute: 0 }, 'America/Los_Angeles');

    expect(next.toISOString()).toBe('2026-01-03T11:00:00.000Z');
  });
});

describe('withAnalysisRunLock', () => {
  test('does not run job body when advisory lock is unavailable', async () => {
    const pool = {
      query: vi.fn().mockResolvedValueOnce({
        rows: [{ locked: false }],
        rowCount: 1,
      }),
    } as unknown as ReturnType<typeof import('../src/db.js').createToolsPool>;

    const run = vi.fn(async () => {});

    const locked = await withAnalysisRunLock(pool, run);

    expect(locked).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(pool.query).toHaveBeenCalledWith('SELECT pg_try_advisory_lock($1) AS locked', [ANALYSIS_RUN_LOCK_KEY]);
  });

  test('runs body and unlocks when advisory lock is acquired', async () => {
    const pool = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [{ locked: true }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({
          rows: [{ pg_advisory_unlock: true }],
          rowCount: 1,
        }),
    } as unknown as ReturnType<typeof import('../src/db.js').createToolsPool>;

    const run = vi.fn(async () => {});

    const locked = await withAnalysisRunLock(pool, run);

    expect(locked).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(pool.query).toHaveBeenNthCalledWith(1, 'SELECT pg_try_advisory_lock($1) AS locked', [ANALYSIS_RUN_LOCK_KEY]);
    expect(pool.query).toHaveBeenNthCalledWith(2, 'SELECT pg_advisory_unlock($1)', [ANALYSIS_RUN_LOCK_KEY]);
  });
});
