import {
  getDailySummary,
  getTopChanges,
  publishReport,
  type StubResponse,
  type TimeWindow,
  traceContext,
} from './agentTools.js';

export type { DailySummary, TimeWindow, TopChangesResult, TraceContextResult } from './agentTools.js';

export { getDailySummary, getTopChanges, traceContext, publishReport };

const stub = (fn: string, todo: string): StubResponse => ({
  status: 'stub',
  function: fn,
  todo,
});

export const entityTimeline = async (
  entityId: string,
  start: string,
  end: string,
  granularity: 'minute' | 'hour' | 'day',
): Promise<StubResponse> =>
  stub(
    'entityTimeline',
    `Implement timeline aggregation for ${entityId} in ${granularity} buckets from ${start} to ${end}.`,
  );

export const correlate = async (entityId: string, window: TimeWindow, topN = 5): Promise<StubResponse> =>
  stub(
    'correlate',
    `Implement temporal correlation for ${entityId} across window ${window.start} -> ${window.end} (topN=${topN}).`,
  );

export const getAutomationSnapshot = async (automationId: string): Promise<StubResponse> =>
  stub('getAutomationSnapshot', `Implement automation snapshot retrieval for ${automationId}.`);

export const listAutomations = async (filter?: Record<string, unknown>): Promise<StubResponse> =>
  stub('listAutomations', `Implement automation listing with filter ${JSON.stringify(filter ?? {})}.`);

export const get_daily_summary = getDailySummary;
export const get_top_changes = getTopChanges;
export const entity_timeline = entityTimeline;
export const trace_context = traceContext;
export const get_automation_snapshot = getAutomationSnapshot;
export const list_automations = listAutomations;
export const publish_report = publishReport;
