import { describe, expect, test } from 'vitest';

import { AgentOutputValidationError, normalizeAgentOutput } from '../src/llm/outputNormalizer.js';

describe('normalizeAgentOutput', () => {
  test('normalizes ranges, deduplicates evidence IDs, and enforces max insight limit', () => {
    const normalized = normalizeAgentOutput(
      {
        run_id: 'run-1',
        generated_at: '2026-01-02T01:00:00.000Z',
        summary: 'Summary',
        ranked_insights: [
          {
            rank: 2,
            title: 'Secondary',
            confidence: 2,
            severity: -10,
            description: 'Secondary summary',
            root_cause: 'secondary cause',
            evidence_ids: ['event:2', 'event:2', 'event:3'],
          },
          {
            rank: 1,
            title: 'Primary',
            confidence: 0.7,
            root_cause: 'primary cause',
            evidence_ids: ['event:1'],
          },
        ],
        proposed_automation_changes: [
          {
            automation_id: 'automation.kitchen_lights',
            change_type: 'adjust_trigger',
            reasoning: 'Reduce noisy triggers',
            related_insight_rank: 1,
          },
        ],
      },
      {
        expectedRunId: 'fallback-run',
        generatedAt: '2026-01-02T02:00:00.000Z',
        maxInsights: 1,
      },
    );

    expect(normalized.rankedInsights).toHaveLength(1);
    expect(normalized.rankedInsights[0]).toMatchObject({
      rank: 1,
      title: 'Primary',
      confidence: 0.7,
      severity: null,
      evidenceIds: ['event:1'],
    });
    expect(normalized.proposedAutomationChanges[0]).toMatchObject({
      automationId: 'automation.kitchen_lights',
      relatedInsightRank: 1,
    });
  });

  test('throws when insight evidence IDs are missing', () => {
    expect(() =>
      normalizeAgentOutput(
        {
          run_id: 'run-1',
          generated_at: '2026-01-02T01:00:00.000Z',
          ranked_insights: [
            {
              rank: 1,
              title: 'Bad insight',
              confidence: 0.1,
              root_cause: 'no evidence',
              evidence_ids: [],
            },
          ],
          proposed_automation_changes: [],
        },
        {
          expectedRunId: 'run-1',
          generatedAt: '2026-01-02T01:00:00.000Z',
          maxInsights: 5,
        },
      ),
    ).toThrow(AgentOutputValidationError);
  });

  test('throws when recommendation related insight rank is missing or invalid', () => {
    expect(() =>
      normalizeAgentOutput(
        {
          run_id: 'run-1',
          generated_at: '2026-01-02T01:00:00.000Z',
          ranked_insights: [
            {
              rank: 1,
              title: 'Valid insight',
              confidence: 0.5,
              root_cause: 'root',
              evidence_ids: ['event:1'],
            },
          ],
          proposed_automation_changes: [
            {
              automation_id: 'automation.kitchen_lights',
              change_type: 'adjust_trigger',
              reasoning: 'Reasonable change',
            },
          ],
        },
        {
          expectedRunId: 'run-1',
          generatedAt: '2026-01-02T01:00:00.000Z',
          maxInsights: 5,
        },
      ),
    ).toThrow('related_insight_rank');

    expect(() =>
      normalizeAgentOutput(
        {
          run_id: 'run-1',
          generated_at: '2026-01-02T01:00:00.000Z',
          ranked_insights: [
            {
              rank: 1,
              title: 'Valid insight',
              confidence: 0.5,
              root_cause: 'root',
              evidence_ids: ['event:1'],
            },
          ],
          proposed_automation_changes: [
            {
              automation_id: 'automation.kitchen_lights',
              change_type: 'adjust_trigger',
              reasoning: 'Reasonable change',
              related_insight_rank: 1.5,
            },
          ],
        },
        {
          expectedRunId: 'run-1',
          generatedAt: '2026-01-02T01:00:00.000Z',
          maxInsights: 5,
        },
      ),
    ).toThrow('related_insight_rank');
  });
});
