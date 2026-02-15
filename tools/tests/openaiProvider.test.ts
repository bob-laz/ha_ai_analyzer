import { afterEach, describe, expect, test, vi } from 'vitest';

import { OpenAIProvider } from '../src/llm/openaiProvider.js';
import type { AnalysisPromptInput } from '../src/llm/types.js';

const input: AnalysisPromptInput = {
  runId: 'run-abc',
  generatedAt: '2026-01-02T01:00:00.000Z',
  window: {
    start: '2026-01-01T01:00:00.000Z',
    end: '2026-01-02T01:00:00.000Z',
    timezone: 'UTC',
    hours: 24,
  },
  dailySummary: {
    day: '2026-01-02',
    timezone: 'UTC',
    totalEvents: 8,
    uniqueEntities: 2,
    stateChanges: 4,
    serviceCalls: 4,
  },
  topChanges: {
    window: {
      start: '2026-01-01T01:00:00.000Z',
      end: '2026-01-02T01:00:00.000Z',
    },
    limit: 20,
    rows: [],
  },
  tracedContexts: [],
  evidenceCatalog: [
    {
      evidenceId: 'event:1',
      evidenceType: 'event',
      eventId: 1,
      entityId: 'light.kitchen',
      contextId: 'ctx-1',
      payload: {},
    },
  ],
  constraints: {
    maxInsights: 5,
    recommendationPolicy: 'propose_only',
  },
};

describe('OpenAIProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  test('retries retryable responses and returns parsed output', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    run_id: 'run-abc',
                    generated_at: '2026-01-02T01:00:00.000Z',
                    ranked_insights: [
                      {
                        rank: 1,
                        title: 'Insight',
                        confidence: 0.8,
                        root_cause: 'cause',
                        evidence_ids: ['event:1'],
                      },
                    ],
                    proposed_automation_changes: [],
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAIProvider({
      apiKey: 'test-key',
      model: 'gpt-4.1-mini',
      timeoutMs: 2_000,
      retryMaxAttempts: 2,
      baseUrl: 'https://example.test/v1',
    });

    const output = await provider.analyze(input);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(output.run_id).toBe('run-abc');
    expect(output.ranked_insights[0]?.title).toBe('Insight');
  });

  test('surfaces timeout errors after attempts are exhausted', async () => {
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';

    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(abortError);
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAIProvider({
      apiKey: 'test-key',
      model: 'gpt-4.1-mini',
      timeoutMs: 50,
      retryMaxAttempts: 1,
    });

    await expect(provider.analyze(input)).rejects.toThrow('OpenAI analysis failed: timeout:50');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
