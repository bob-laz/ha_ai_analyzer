import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Pool } from 'pg';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { AnalysisRepo } from '../src/analysisRepo.js';
import { runAnalysis } from '../src/analysisRunner.js';
import type { LLMProvider } from '../src/llm/provider.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fixturesDir = join(__dirname, 'fixtures');

const agentToolsMocks = vi.hoisted(() => ({
  getDailySummary: vi.fn(),
  getTopChanges: vi.fn(),
  traceContext: vi.fn(),
  publishReport: vi.fn(),
}));

vi.mock('../src/agentTools.js', () => agentToolsMocks);

const readFixture = async <T>(name: string): Promise<T> => {
  const raw = await readFile(join(fixturesDir, name), 'utf8');
  return JSON.parse(raw) as T;
};

const createFakePool = (): Pool => {
  const client = {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    release: vi.fn(),
  };

  return {
    connect: vi.fn(async () => client),
  } as unknown as Pool;
};

describe('runAnalysis', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    agentToolsMocks.getDailySummary.mockResolvedValue({
      day: '2026-01-02',
      timezone: 'UTC',
      totalEvents: 8,
      uniqueEntities: 2,
      stateChanges: 4,
      serviceCalls: 4,
    });
    agentToolsMocks.getTopChanges.mockResolvedValue({
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
    });
    agentToolsMocks.traceContext.mockResolvedValue({
      requestedContextId: 'ctx-child',
      rootContextId: 'ctx-root',
      contextDepth: [
        { contextId: 'ctx-child', depth: 0 },
        { contextId: 'ctx-root', depth: 1 },
      ],
      relatedContextMetadata: [],
      events: [
        {
          id: 101,
          eventTime: '2026-01-02T00:08:00.000Z',
          eventType: 'call_service',
          domain: 'light',
          entityId: null,
          service: 'turn_on',
          contextId: 'ctx-child',
          parentContextId: 'ctx-root',
          userId: 'user-1',
          data: {},
        },
      ],
    });
    agentToolsMocks.publishReport.mockResolvedValue({
      status: 'published',
      analysisResultId: 42,
      markdownPreview: '# LLM Event Analysis',
      payloadKeys: ['reportType'],
    });
  });

  test('persists normalized artifacts and publishes report in order', async () => {
    const callOrder: string[] = [];
    const repo: AnalysisRepo = {
      createAgentRun: vi.fn(async () => {
        callOrder.push('createAgentRun');
        return { id: 7, runUuid: 'run-uuid-1' };
      }),
      completeAgentRun: vi.fn(async () => {
        callOrder.push('completeAgentRun');
      }),
      failAgentRun: vi.fn(async () => {
        callOrder.push('failAgentRun');
      }),
      listTopContextIds: vi.fn(async () => {
        callOrder.push('listTopContextIds');
        return ['ctx-child'];
      }),
      getLatestEnvironmentInventory: vi.fn(async () => {
        callOrder.push('getLatestEnvironmentInventory');
        return {
          capturedAt: '2026-01-02T00:59:00.000Z',
          countsByType: {
            device: 2,
            service: 2,
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
            device: [
              { resourceId: 'device-1', label: 'Kitchen Sensor', metadata: { manufacturer: 'Acme', model: 'S1' } },
              { resourceId: 'device-2', label: 'Bedroom Motion', metadata: { manufacturer: 'Acme', model: 'M2' } },
            ],
            service: [
              {
                resourceId: 'light.turn_on',
                label: 'Turn on',
                metadata: { definition: { fields: { entity_id: {}, brightness_pct: {} }, target: { entity: {} } } },
              },
              {
                resourceId: 'light.turn_off',
                label: 'Turn off',
                metadata: { definition: { fields: { entity_id: {} }, target: { entity: {} } } },
              },
            ],
            integration: [
              {
                resourceId: 'entry-1',
                label: 'Mobile App',
                metadata: { domain: 'mobile_app', source: 'user', state: 'loaded', raw: { supports_unload: true } },
              },
            ],
            addon: [
              {
                resourceId: 'mosquitto',
                label: 'Mosquitto broker',
                metadata: { version: '6.4.0', installed: true, state: 'started' },
              },
            ],
          },
        };
      }),
      getLatestResourceUsageSnapshot: vi.fn(async () => {
        callOrder.push('getLatestResourceUsageSnapshot');
        return {
          capturedAt: '2026-01-02T00:59:00.000Z',
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
                metadata: { friendlyName: 'Daily Energy', stateClass: 'total_increasing' },
              },
              {
                entityId: 'sensor.monthly_energy',
                readingNumeric: 220.1,
                readingText: '220.1',
                unit: 'kWh',
                metadata: { friendlyName: 'Monthly Energy', stateClass: 'total_increasing' },
              },
            ],
            water: [
              {
                entityId: 'sensor.water_meter_total',
                readingNumeric: 4.2,
                readingText: '4.2',
                unit: 'm3',
                metadata: { friendlyName: 'Water Meter Total', stateClass: 'total_increasing' },
              },
            ],
            gas: [
              {
                entityId: 'sensor.gas_meter_total',
                readingNumeric: 3.1,
                readingText: '3.1',
                unit: 'm3',
                metadata: { friendlyName: 'Gas Meter Total', stateClass: 'total_increasing' },
              },
            ],
            power: [
              {
                entityId: 'sensor.home_power_now',
                readingNumeric: 820,
                readingText: '820',
                unit: 'W',
                metadata: { friendlyName: 'Home Power', stateClass: 'measurement' },
              },
            ],
          },
        };
      }),
      insertInsights: vi.fn(async () => {
        callOrder.push('insertInsights');
        return [{ id: 11, rank: 1 }];
      }),
      insertEvidence: vi.fn(async () => {
        callOrder.push('insertEvidence');
      }),
      insertRecommendations: vi.fn(async () => {
        callOrder.push('insertRecommendations');
      }),
    };

    const provider: LLMProvider = {
      analyze: vi.fn(async () => ({
        run_id: 'run-uuid-1',
        generated_at: '2026-01-02T01:00:00.000Z',
        summary: 'Focused analysis summary',
        ranked_insights: [
          {
            rank: 1,
            title: 'Light turn_on usage increased',
            confidence: 0.9,
            severity: 0.6,
            description: 'Service calls increased in the latest window.',
            root_cause: 'Automation burst in living room profile',
            evidence_ids: ['change:service:light.turn_on', 'event:101'],
            category: 'automation',
          },
        ],
        proposed_automation_changes: [
          {
            automation_id: 'automation.living_room_evening',
            change_type: 'adjust_trigger',
            reasoning: 'Reduce unnecessary trigger fan-out',
            related_insight_rank: 1,
          },
        ],
      })),
    };

    const result = await runAnalysis(
      createFakePool(),
      provider,
      {
        runType: 'llm_analysis',
        timezone: 'UTC',
        windowHours: 24,
        maxInsights: 5,
        maxTopChanges: 20,
        maxTraceContexts: 10,
        maxEventsPerContext: 60,
        traceMaxDepth: 6,
        maxEnvironmentItemsPerType: 50,
        maxResourceUsageItemsPerType: 20,
      },
      {
        repo,
        now: () => new Date('2026-01-02T01:00:00.000Z'),
      },
    );

    const golden = await readFixture<Record<string, unknown>>('llmAnalysisReport.golden.json');
    expect(result.reportPayload).toEqual(golden);
    expect(result.analysisResultId).toBe(42);
    expect(callOrder).toEqual([
      'createAgentRun',
      'listTopContextIds',
      'getLatestEnvironmentInventory',
      'getLatestResourceUsageSnapshot',
      'insertInsights',
      'insertEvidence',
      'insertRecommendations',
      'completeAgentRun',
    ]);
    expect(agentToolsMocks.publishReport).toHaveBeenCalledTimes(1);
  });

  test('marks run failed when provider throws', async () => {
    const repo: AnalysisRepo = {
      createAgentRun: vi.fn(async () => ({ id: 10, runUuid: 'run-fail-1' })),
      completeAgentRun: vi.fn(async () => {}),
      failAgentRun: vi.fn(async () => {}),
      listTopContextIds: vi.fn(async () => ['ctx-child']),
      getLatestEnvironmentInventory: vi.fn(async () => null),
      getLatestResourceUsageSnapshot: vi.fn(async () => null),
      insertInsights: vi.fn(async () => []),
      insertEvidence: vi.fn(async () => {}),
      insertRecommendations: vi.fn(async () => {}),
    };

    const provider: LLMProvider = {
      analyze: vi.fn(async () => {
        throw new Error('provider boom');
      }),
    };

    await expect(
      runAnalysis(
        createFakePool(),
        provider,
        {
          runType: 'llm_analysis',
          timezone: 'UTC',
          windowHours: 24,
          maxInsights: 5,
          maxTopChanges: 20,
          maxTraceContexts: 10,
          maxEventsPerContext: 60,
          traceMaxDepth: 6,
          maxEnvironmentItemsPerType: 50,
          maxResourceUsageItemsPerType: 20,
        },
        {
          repo,
          now: () => new Date('2026-01-02T01:00:00.000Z'),
        },
      ),
    ).rejects.toThrow('provider boom');

    expect(repo.failAgentRun).toHaveBeenCalledTimes(1);
    expect(repo.completeAgentRun).not.toHaveBeenCalled();
    expect(agentToolsMocks.publishReport).not.toHaveBeenCalled();
  });
});
