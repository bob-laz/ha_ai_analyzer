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
