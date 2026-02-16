import crypto from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import {
  type DailySummary,
  getDailySummary,
  getTopChanges,
  publishReport,
  type TopChangesResult,
  type TraceContextResult,
  traceContext,
} from './agentTools.js';
import { type AnalysisRepo, analysisRepo, type EvidenceInsert, type RecommendationInsert } from './analysisRepo.js';
import type { SqlQueryable } from './db.js';
import { normalizeAgentOutput } from './llm/outputNormalizer.js';
import type { LLMProvider } from './llm/provider.js';
import type {
  AnalysisPromptInput,
  EvidenceCatalogItem,
  HomeAssistantInventory,
  HomeAssistantInventoryItem,
  HomeAssistantInventoryType,
  NormalizedAgentOutput,
  ResourceUsageReading,
  ResourceUsageSnapshot,
  ResourceUsageType,
  TraceBundle,
} from './llm/types.js';

export type AnalysisRunnerConfig = {
  runType: string;
  timezone: string;
  windowHours: number;
  maxInsights: number;
  maxTopChanges: number;
  maxTraceContexts: number;
  maxEventsPerContext: number;
  traceMaxDepth: number;
  maxEnvironmentItemsPerType: number;
  maxResourceUsageItemsPerType: number;
};

export type AnalysisRunResult = {
  agentRunId: number;
  runUuid: string;
  markdown: string;
  reportPayload: Record<string, unknown>;
  analysisResultId: number | null;
};

type AnalysisRunnerDependencies = {
  repo?: AnalysisRepo;
  now?: () => Date;
};

const dayInTimezone = (date: Date, timezone: string): string => {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  const parts = formatter.formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;

  if (!year || !month || !day) {
    throw new Error(`Unable to format day for timezone '${timezone}'`);
  }

  return `${year}-${month}-${day}`;
};

const requireNonStub = <T extends object>(value: T | { status: 'stub'; function: string }): T => {
  if ('status' in value && value.status === 'stub') {
    throw new Error(`${value.function} returned stub while analysis requires DB-backed execution`);
  }
  return value as T;
};

const clampContextEvents = (trace: TraceContextResult, maxEvents: number): TraceContextResult => ({
  ...trace,
  events: trace.events.slice(0, maxEvents),
});

const buildEvidenceCatalog = (topChanges: TopChangesResult, traces: TraceBundle[]): EvidenceCatalogItem[] => {
  const catalog = new Map<string, EvidenceCatalogItem>();

  for (const row of topChanges.rows) {
    const evidenceId = `change:${row.subjectType}:${row.subjectId}`;
    catalog.set(evidenceId, {
      evidenceId,
      evidenceType: 'top_change',
      eventId: null,
      entityId: row.subjectType === 'entity' ? row.subjectId : null,
      contextId: null,
      payload: {
        subjectType: row.subjectType,
        subjectId: row.subjectId,
        currentCount: row.currentCount,
        previousCount: row.previousCount,
        delta: row.delta,
      },
    });
  }

  for (const bundle of traces) {
    const contextEvidenceId = `context:${bundle.contextId}`;
    if (!catalog.has(contextEvidenceId)) {
      catalog.set(contextEvidenceId, {
        evidenceId: contextEvidenceId,
        evidenceType: 'context',
        eventId: null,
        entityId: null,
        contextId: bundle.contextId,
        payload: {
          requestedContextId: bundle.trace.requestedContextId,
          rootContextId: bundle.trace.rootContextId,
          eventCount: bundle.trace.events.length,
        },
      });
    }

    for (const event of bundle.trace.events) {
      const evidenceId = `event:${event.id}`;
      if (catalog.has(evidenceId)) {
        continue;
      }

      catalog.set(evidenceId, {
        evidenceId,
        evidenceType: 'event',
        eventId: event.id,
        entityId: event.entityId,
        contextId: event.contextId,
        payload: {
          eventType: event.eventType,
          eventTime: event.eventTime,
          domain: event.domain,
          entityId: event.entityId,
          service: event.service,
          contextId: event.contextId,
          parentContextId: event.parentContextId,
          userId: event.userId,
        },
      });
    }
  }

  return [...catalog.values()];
};

const buildMarkdownReport = (normalized: NormalizedAgentOutput, input: AnalysisPromptInput): string => {
  const lines: string[] = [];
  lines.push(`# LLM Event Analysis`);
  lines.push('');
  lines.push(`- Run ID: ${input.runId}`);
  lines.push(`- Generated at: ${normalized.generatedAt}`);
  lines.push(`- Window: ${input.window.start} to ${input.window.end} (${input.window.timezone})`);
  lines.push(`- Total events in summary day: ${input.dailySummary.totalEvents}`);
  if (input.homeAssistantInventory) {
    lines.push(`- HA inventory snapshot: ${input.homeAssistantInventory.capturedAt}`);
    lines.push(
      `- HA inventory counts: devices ${input.homeAssistantInventory.countsByType.device}, services ${input.homeAssistantInventory.countsByType.service}, integrations ${input.homeAssistantInventory.countsByType.integration}, addons ${input.homeAssistantInventory.countsByType.addon}`,
    );
  }
  if (input.resourceUsageSnapshot) {
    lines.push(`- Resource usage snapshot: ${input.resourceUsageSnapshot.capturedAt}`);
    lines.push(
      `- Resource usage counts: energy ${input.resourceUsageSnapshot.countsByType.energy}, water ${input.resourceUsageSnapshot.countsByType.water}, gas ${input.resourceUsageSnapshot.countsByType.gas}, power ${input.resourceUsageSnapshot.countsByType.power}`,
    );
  }
  lines.push('');
  lines.push('## Summary');
  lines.push(normalized.summary);
  lines.push('');
  lines.push('## Ranked Insights');

  for (const insight of normalized.rankedInsights) {
    lines.push(`${insight.rank}. **${insight.title}** (confidence ${insight.confidence.toFixed(2)})`);
    lines.push(`   - Category: ${insight.category}`);
    if (insight.severity !== null) {
      lines.push(`   - Severity: ${insight.severity.toFixed(2)}`);
    }
    lines.push(`   - Root cause: ${insight.rootCause}`);
    lines.push(`   - Evidence IDs: ${insight.evidenceIds.join(', ')}`);
    lines.push(`   - Summary: ${insight.summary}`);
  }

  lines.push('');
  lines.push('## Proposed Automation Changes');
  if (normalized.proposedAutomationChanges.length === 0) {
    lines.push('- No proposed changes.');
  } else {
    for (const change of normalized.proposedAutomationChanges) {
      lines.push(`- ${change.automationId} :: ${change.changeType}`);
      lines.push(`  - Reasoning: ${change.reasoning}`);
      if (change.estimatedImpact) {
        lines.push(`  - Estimated impact: ${change.estimatedImpact}`);
      }
      if (change.proposedYamlPatch) {
        lines.push(`  - Proposed patch: ${change.proposedYamlPatch}`);
      }
      if (change.relatedInsightRank !== null) {
        lines.push(`  - Related insight rank: ${change.relatedInsightRank}`);
      }
      lines.push(`  - Status: proposed`);
    }
  }

  return lines.join('\n');
};

const compactServiceMetadata = (item: HomeAssistantInventoryItem): Record<string, unknown> => {
  const serviceId = item.resourceId;
  const [domain, service] = serviceId.split('.', 2);
  const definition =
    item.metadata.definition && typeof item.metadata.definition === 'object'
      ? (item.metadata.definition as Record<string, unknown>)
      : {};
  const fields =
    definition.fields && typeof definition.fields === 'object' ? (definition.fields as Record<string, unknown>) : {};
  const target =
    definition.target && typeof definition.target === 'object' ? (definition.target as Record<string, unknown>) : {};

  return {
    id: serviceId,
    label: item.label,
    domain: domain ?? null,
    service: service ?? null,
    fieldNames: Object.keys(fields).slice(0, 12),
    hasTargetSelector: Object.keys(target).length > 0,
  };
};

const compactDeviceMetadata = (item: HomeAssistantInventoryItem): Record<string, unknown> => {
  return {
    id: item.resourceId,
    label: item.label,
    manufacturer: typeof item.metadata.manufacturer === 'string' ? item.metadata.manufacturer : null,
    model: typeof item.metadata.model === 'string' ? item.metadata.model : null,
    areaId: typeof item.metadata.area_id === 'string' ? item.metadata.area_id : null,
    disabledBy: typeof item.metadata.disabled_by === 'string' ? item.metadata.disabled_by : null,
  };
};

const compactIntegrationMetadata = (item: HomeAssistantInventoryItem): Record<string, unknown> => {
  const raw =
    item.metadata.raw && typeof item.metadata.raw === 'object' ? (item.metadata.raw as Record<string, unknown>) : {};
  const supportsUnload =
    typeof raw.supports_unload === 'boolean' ? raw.supports_unload : typeof raw.supports_unload === 'number';

  return {
    id: item.resourceId,
    label: item.label,
    domain: typeof item.metadata.domain === 'string' ? item.metadata.domain : null,
    state: typeof item.metadata.state === 'string' ? item.metadata.state : null,
    source: typeof item.metadata.source === 'string' ? item.metadata.source : null,
    disabledBy: typeof item.metadata.disabledBy === 'string' ? item.metadata.disabledBy : null,
    supportsUnload,
  };
};

const compactAddonMetadata = (item: HomeAssistantInventoryItem): Record<string, unknown> => {
  return {
    id: item.resourceId,
    label: item.label,
    version: typeof item.metadata.version === 'string' ? item.metadata.version : null,
    installed: typeof item.metadata.installed === 'boolean' ? item.metadata.installed : null,
    state: typeof item.metadata.state === 'string' ? item.metadata.state : null,
    updateAvailable:
      typeof item.metadata.update_available === 'boolean'
        ? item.metadata.update_available
        : typeof item.metadata.update_available === 'string'
          ? item.metadata.update_available
          : null,
  };
};

const compactInventoryByType = (
  inventory: HomeAssistantInventory,
): Record<HomeAssistantInventoryType, Array<Record<string, unknown>>> => ({
  device: inventory.itemsByType.device.map(compactDeviceMetadata),
  service: inventory.itemsByType.service.map(compactServiceMetadata),
  integration: inventory.itemsByType.integration.map(compactIntegrationMetadata),
  addon: inventory.itemsByType.addon.map(compactAddonMetadata),
});

const compactUsageReading = (reading: ResourceUsageReading): Record<string, unknown> => ({
  entityId: reading.entityId,
  reading: reading.readingNumeric ?? reading.readingText,
  unit: reading.unit,
  friendlyName: typeof reading.metadata.friendlyName === 'string' ? reading.metadata.friendlyName : null,
  stateClass: typeof reading.metadata.stateClass === 'string' ? reading.metadata.stateClass : null,
});

const compactUsageByType = (
  snapshot: ResourceUsageSnapshot,
): Record<ResourceUsageType, Array<Record<string, unknown>>> => ({
  energy: snapshot.itemsByType.energy.map(compactUsageReading),
  water: snapshot.itemsByType.water.map(compactUsageReading),
  gas: snapshot.itemsByType.gas.map(compactUsageReading),
  power: snapshot.itemsByType.power.map(compactUsageReading),
});

const withTransaction = async <T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // noop
    }
    throw error;
  } finally {
    client.release();
  }
};

export const runAnalysis = async (
  pool: Pool,
  provider: LLMProvider,
  config: AnalysisRunnerConfig,
  dependencies: AnalysisRunnerDependencies = {},
): Promise<AnalysisRunResult> => {
  const repo = dependencies.repo ?? analysisRepo;
  const now = dependencies.now ? dependencies.now() : new Date();

  const windowEnd = now;
  const windowStart = new Date(windowEnd.getTime() - config.windowHours * 60 * 60 * 1000);

  const runConfigMetadata: Record<string, unknown> = {
    timezone: config.timezone,
    windowHours: config.windowHours,
    maxInsights: config.maxInsights,
    maxTopChanges: config.maxTopChanges,
    maxTraceContexts: config.maxTraceContexts,
    maxEventsPerContext: config.maxEventsPerContext,
    traceMaxDepth: config.traceMaxDepth,
    maxEnvironmentItemsPerType: config.maxEnvironmentItemsPerType,
    maxResourceUsageItemsPerType: config.maxResourceUsageItemsPerType,
    llmProvider: provider.constructor.name,
  };

  const run = await repo.createAgentRun(pool, {
    runType: config.runType,
    status: 'running',
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    config: runConfigMetadata,
  });

  try {
    const summaryDay = dayInTimezone(windowEnd, config.timezone);
    const dailySummary = requireNonStub(await getDailySummary(summaryDay, pool, config.timezone)) as DailySummary;

    const topChanges = requireNonStub(
      await getTopChanges(
        {
          start: windowStart.toISOString(),
          end: windowEnd.toISOString(),
        },
        config.maxTopChanges,
        pool,
      ),
    ) as TopChangesResult;

    const topContextIds = await repo.listTopContextIds(
      pool,
      windowStart.toISOString(),
      windowEnd.toISOString(),
      config.maxTraceContexts,
    );
    const environmentInventory = await repo.getLatestEnvironmentInventory(pool, config.maxEnvironmentItemsPerType);
    const compactEnvironmentInventory = environmentInventory
      ? {
          ...environmentInventory,
          compactItemsByType: compactInventoryByType(environmentInventory),
        }
      : null;
    const resourceUsageSnapshot = await repo.getLatestResourceUsageSnapshot(pool, config.maxResourceUsageItemsPerType);
    const compactResourceUsageSnapshot = resourceUsageSnapshot
      ? {
          ...resourceUsageSnapshot,
          compactItemsByType: compactUsageByType(resourceUsageSnapshot),
        }
      : null;

    const tracedContexts: TraceBundle[] = [];
    const truncatedContexts: Array<{ contextId: string; originalEvents: number; retainedEvents: number }> = [];
    for (const contextId of topContextIds) {
      const trace = requireNonStub(await traceContext(contextId, pool, config.traceMaxDepth)) as TraceContextResult;
      const retainedTrace = clampContextEvents(trace, config.maxEventsPerContext);
      if (trace.events.length > retainedTrace.events.length) {
        truncatedContexts.push({
          contextId,
          originalEvents: trace.events.length,
          retainedEvents: retainedTrace.events.length,
        });
      }

      tracedContexts.push({
        contextId,
        trace: retainedTrace,
      });
    }

    const evidenceCatalog = buildEvidenceCatalog(topChanges, tracedContexts);

    const promptInput: AnalysisPromptInput = {
      runId: run.runUuid,
      generatedAt: now.toISOString(),
      window: {
        start: windowStart.toISOString(),
        end: windowEnd.toISOString(),
        timezone: config.timezone,
        hours: config.windowHours,
      },
      dailySummary,
      topChanges,
      tracedContexts,
      evidenceCatalog,
      homeAssistantInventory: compactEnvironmentInventory,
      resourceUsageSnapshot: compactResourceUsageSnapshot,
      constraints: {
        maxInsights: config.maxInsights,
        recommendationPolicy: 'propose_only',
      },
    };

    const modelOutput = await provider.analyze(promptInput);
    const normalized = normalizeAgentOutput(modelOutput, {
      expectedRunId: run.runUuid,
      generatedAt: now.toISOString(),
      maxInsights: config.maxInsights,
    });

    const markdown = buildMarkdownReport(normalized, promptInput);
    const reportPayload: Record<string, unknown> = {
      reportType: 'llm_analysis',
      runId: run.runUuid,
      generatedAt: normalized.generatedAt,
      window: promptInput.window,
      dailySummary,
      topChanges,
      rankedInsights: normalized.rankedInsights,
      proposedAutomationChanges: normalized.proposedAutomationChanges,
      summary: normalized.summary,
      homeAssistantInventory: compactEnvironmentInventory,
      resourceUsageSnapshot: compactResourceUsageSnapshot,
      truncation: {
        maxEventsPerContext: config.maxEventsPerContext,
        truncatedContexts,
        totalDroppedEvents: truncatedContexts.reduce(
          (count, item) => count + (item.originalEvents - item.retainedEvents),
          0,
        ),
      },
    };

    const evidenceById = new Map<string, EvidenceCatalogItem>(evidenceCatalog.map((item) => [item.evidenceId, item]));

    const persistResult = await withTransaction(pool, async (client) => {
      const insertedInsights = await repo.insertInsights(client, run.id, normalized.rankedInsights);
      const insightIdByRank = new Map<number, number>(insertedInsights.map((row) => [row.rank, row.id]));

      const evidenceRows: EvidenceInsert[] = [];
      for (const insight of normalized.rankedInsights) {
        const insightId = insightIdByRank.get(insight.rank);
        if (!insightId) {
          continue;
        }

        for (const evidenceId of insight.evidenceIds) {
          const catalogEntry = evidenceById.get(evidenceId);
          if (!catalogEntry) {
            evidenceRows.push({
              insightId,
              evidenceType: 'unknown',
              eventId: null,
              entityId: null,
              contextId: null,
              payload: {
                evidenceId,
                source: 'model_reference_only',
              },
            });
            continue;
          }

          evidenceRows.push({
            insightId,
            evidenceType: catalogEntry.evidenceType,
            eventId: catalogEntry.eventId,
            entityId: catalogEntry.entityId,
            contextId: catalogEntry.contextId,
            payload: {
              evidenceId,
              ...catalogEntry.payload,
            },
          });
        }
      }

      await repo.insertEvidence(client, evidenceRows);

      const recommendationRows: RecommendationInsert[] = normalized.proposedAutomationChanges.map((change) => ({
        insightId: change.relatedInsightRank === null ? null : (insightIdByRank.get(change.relatedInsightRank) ?? null),
        recommendationType: change.changeType,
        targetAutomationId: change.automationId,
        changePayload: {
          automationId: change.automationId,
          changeType: change.changeType,
          reasoning: change.reasoning,
          proposedYamlPatch: change.proposedYamlPatch,
          estimatedImpact: change.estimatedImpact,
          relatedInsightRank: change.relatedInsightRank,
          policy: 'propose_only',
        },
        status: 'proposed',
      }));

      await repo.insertRecommendations(client, run.id, recommendationRows);

      const published = await publishReport(markdown, reportPayload, client as SqlQueryable, run.id);
      if (published.status !== 'published') {
        throw new Error('publishReport returned stub while DB client was provided');
      }

      await repo.completeAgentRun(client, run.id, {
        llm_analysis: {
          insights: normalized.rankedInsights.length,
          recommendations: normalized.proposedAutomationChanges.length,
          evidence_rows: evidenceRows.length,
          analysis_result_id: published.analysisResultId ?? null,
          completed_at: new Date().toISOString(),
          provider: provider.constructor.name,
          truncation: {
            maxEventsPerContext: config.maxEventsPerContext,
            truncatedContexts,
          },
        },
      });

      return {
        analysisResultId: published.analysisResultId ?? null,
      };
    });

    return {
      agentRunId: run.id,
      runUuid: run.runUuid,
      markdown,
      reportPayload,
      analysisResultId: persistResult.analysisResultId,
    };
  } catch (error) {
    await repo.failAgentRun(pool, run.id, {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      failed_at: new Date().toISOString(),
      error_id: crypto.randomUUID(),
    });

    throw error;
  }
};
