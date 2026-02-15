import {
  correlate,
  entityTimeline,
  getAutomationSnapshot,
  getDailySummary,
  getTopChanges,
  listAutomations,
  publishReport,
  traceContext,
} from './agentTools.js';

export type {
  AutomationSnapshotResult,
  CorrelationResult,
  DailySummary,
  EntityTimelineResult,
  ListAutomationsResult,
  TimeWindow,
  TopChangesResult,
  TraceContextResult,
} from './agentTools.js';

export {
  correlate,
  entityTimeline,
  getAutomationSnapshot,
  getDailySummary,
  getTopChanges,
  listAutomations,
  traceContext,
  publishReport,
};

export const get_daily_summary = getDailySummary;
export const get_top_changes = getTopChanges;
export const entity_timeline = entityTimeline;
export const trace_context = traceContext;
export const get_automation_snapshot = getAutomationSnapshot;
export const list_automations = listAutomations;
export const publish_report = publishReport;
