import { describe, expect, test } from 'vitest';

import { buildAnalysisPrompt } from '../src/llm/promptBuilder.js';

describe('buildAnalysisPrompt', () => {
  test('emits deterministic prompt sections and schema payload', () => {
    const prompt = buildAnalysisPrompt({
      runId: 'run-123',
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
        rows: [
          {
            subjectType: 'service',
            subjectId: 'light.turn_on',
            currentCount: 4,
            previousCount: 1,
            delta: 3,
          },
        ],
      },
      tracedContexts: [
        {
          contextId: 'ctx-child',
          trace: {
            requestedContextId: 'ctx-child',
            rootContextId: 'ctx-root',
            contextDepth: [
              { contextId: 'ctx-child', depth: 0 },
              { contextId: 'ctx-root', depth: 1 },
            ],
            relatedContextMetadata: [],
            events: [],
          },
        },
      ],
      evidenceCatalog: [
        {
          evidenceId: 'change:service:light.turn_on',
          evidenceType: 'top_change',
          eventId: null,
          entityId: null,
          contextId: null,
          payload: { delta: 3 },
        },
      ],
      constraints: {
        maxInsights: 5,
        recommendationPolicy: 'propose_only',
      },
    });

    expect(prompt.systemPrompt).toContain('Return only valid JSON');
    expect(prompt.systemPrompt).toContain('Recommendations are proposals only');

    const parsed = JSON.parse(prompt.userPrompt) as Record<string, unknown>;
    expect(parsed.objective).toContain('Analyze the event window');
    expect(parsed).toMatchObject({
      run: {
        run_id: 'run-123',
        generated_at: '2026-01-02T01:00:00.000Z',
      },
      constraints: {
        max_insights: 5,
        recommendation_policy: 'propose_only',
        output_must_match_schema: true,
      },
    });
    expect((parsed.output_schema as { required?: string[] }).required).toEqual([
      'run_id',
      'generated_at',
      'ranked_insights',
      'proposed_automation_changes',
    ]);
  });
});
