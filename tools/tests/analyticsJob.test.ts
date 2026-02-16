import { describe, expect, test, vi } from 'vitest';

import {
  ANALYSIS_RUN_LOCK_KEY,
  buildHomeAssistantNotificationMessage,
  computeNextScheduledRunAt,
  deriveHaHttpUrlFromWsUrl,
  publishHomeAssistantNotification,
  withAnalysisRunLock,
} from '../src/analyticsJob.js';

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

describe('deriveHaHttpUrlFromWsUrl', () => {
  test('derives HTTP base URL from websocket URL', () => {
    expect(deriveHaHttpUrlFromWsUrl('ws://192.168.1.50:8123/api/websocket')).toBe('http://192.168.1.50:8123');
    expect(deriveHaHttpUrlFromWsUrl('wss://ha.example.com/api/websocket')).toBe('https://ha.example.com');
    expect(deriveHaHttpUrlFromWsUrl(undefined)).toBeNull();
    expect(deriveHaHttpUrlFromWsUrl('not-a-url')).toBeNull();
  });
});

describe('HA notification helpers', () => {
  test('buildHomeAssistantNotificationMessage emits readable report summary', () => {
    const message = buildHomeAssistantNotificationMessage(
      {
        agentRunId: 7,
        runUuid: 'run-123',
        markdown: '# markdown',
        analysisResultId: 42,
        reportPayload: {
          summary: 'Lighting automations are firing too frequently at night.',
          window: {
            start: '2026-01-01T01:00:00.000Z',
            end: '2026-01-02T01:00:00.000Z',
            timezone: 'UTC',
          },
          rankedInsights: [
            { rank: 1, title: 'Night motion spam', confidence: 0.91 },
            { rank: 2, title: 'Repeated turn_on bursts', confidence: 0.82 },
          ],
          proposedAutomationChanges: [
            {
              automationId: 'automation.night_motion',
              changeType: 'adjust_trigger',
              reasoning: 'Increase debounce to reduce duplicate firings.',
            },
          ],
        },
      },
      6_000,
    );

    expect(message).toContain('# Home Assistant AI Analysis');
    expect(message).toContain('Night motion spam');
    expect(message).toContain('automation.night_motion: adjust_trigger');
  });

  test('publishHomeAssistantNotification posts persistent notification payload', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const published = await publishHomeAssistantNotification(
      {
        agentRunId: 7,
        runUuid: 'run-123',
        markdown: '# markdown',
        analysisResultId: 42,
        reportPayload: {
          summary: 'Summary',
          rankedInsights: [],
          proposedAutomationChanges: [],
        },
      },
      {
        enabled: true,
        haHttpUrl: 'http://127.0.0.1:8123',
        haToken: 'token',
        title: 'Home Assistant AI Analysis',
        notificationId: 'ha_ai_llm_analysis_latest',
        maxMessageChars: 4_000,
        requestTimeoutMs: 5_000,
      },
    );

    expect(published).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('http://127.0.0.1:8123/api/services/persistent_notification/create');
    expect((init as RequestInit).method).toBe('POST');
  });
});
