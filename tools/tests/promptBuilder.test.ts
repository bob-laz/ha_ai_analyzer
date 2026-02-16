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
      homeAssistantInventory: {
        capturedAt: '2026-01-02T00:59:00.000Z',
        countsByType: {
          device: 2,
          service: 3,
          integration: 1,
          addon: 1,
        },
        truncatedByType: {
          device: 0,
          service: 0,
          integration: 0,
          addon: 0,
        },
        itemsByType: {
          device: [{ resourceId: 'device-1', label: 'Kitchen Sensor', metadata: { manufacturer: 'Acme' } }],
          service: [{ resourceId: 'light.turn_on', label: 'Turn on', metadata: { domain: 'light' } }],
          integration: [{ resourceId: 'entry-1', label: 'Mobile App', metadata: { domain: 'mobile_app' } }],
          addon: [{ resourceId: 'mosquitto', label: 'Mosquitto', metadata: { installed: true } }],
        },
      },
      resourceUsageSnapshot: {
        capturedAt: '2026-01-02T00:58:00.000Z',
        countsByType: {
          energy: 2,
          water: 1,
          gas: 1,
          power: 1,
        },
        truncatedByType: {
          energy: 0,
          water: 0,
          gas: 0,
          power: 0,
        },
        itemsByType: {
          energy: [
            {
              entityId: 'sensor.daily_energy',
              readingNumeric: 12.5,
              readingText: '12.5',
              unit: 'kWh',
              metadata: { friendlyName: 'Daily Energy' },
            },
          ],
          water: [
            {
              entityId: 'sensor.water_meter_total',
              readingNumeric: 4.2,
              readingText: '4.2',
              unit: 'm3',
              metadata: { friendlyName: 'Water Meter Total' },
            },
          ],
          gas: [
            {
              entityId: 'sensor.gas_meter_total',
              readingNumeric: 3.1,
              readingText: '3.1',
              unit: 'm3',
              metadata: { friendlyName: 'Gas Meter Total' },
            },
          ],
          power: [
            {
              entityId: 'sensor.home_power_now',
              readingNumeric: 820,
              readingText: '820',
              unit: 'W',
              metadata: { friendlyName: 'Home Power' },
            },
          ],
        },
      },
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
      home_assistant_inventory: {
        counts_by_type: {
          device: 2,
          service: 3,
          integration: 1,
          addon: 1,
        },
      },
      resource_usage_snapshot: {
        counts_by_type: {
          energy: 2,
          water: 1,
          gas: 1,
          power: 1,
        },
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
