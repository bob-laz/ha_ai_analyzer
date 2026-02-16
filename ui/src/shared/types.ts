export type RecommendationStatus = 'proposed' | 'accepted' | 'rejected';

export type OperationKind = 'run-analysis' | 'run-daily-summary' | 'run-automation-snapshots' | 'run-retention';

export type OperationStatus = 'queued' | 'running' | 'completed' | 'failed';

export type ActionOperation = {
  id: string;
  kind: OperationKind;
  status: OperationStatus;
  message: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  exitCode: number | null;
  outputPreview: string | null;
};

export type OverviewResponse = {
  latestCollectorEventAt: string | null;
  ingestion: {
    events5m: number;
    events1h: number;
    events24h: number;
  };
  latestRunsByType: Array<{
    id: number;
    runType: string;
    status: string;
    startedAt: string;
    completedAt: string | null;
  }>;
  recommendationCounts: Record<string, number>;
  latestDailySummary: {
    reportId: number | null;
    targetDay: string | null;
    anomalyCount: number;
    publishedAt: string | null;
  };
};

export type RunRow = {
  id: number;
  runUuid: string;
  runType: string;
  status: string;
  windowStart: string | null;
  windowEnd: string | null;
  startedAt: string;
  completedAt: string | null;
  config: Record<string, unknown>;
};

export type RunsResponse = {
  runs: RunRow[];
};

export type RecommendationRow = {
  id: number;
  agentRunId: number | null;
  insightId: number | null;
  recommendationType: string;
  targetAutomationId: string | null;
  status: RecommendationStatus;
  changePayload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  insightRank: number | null;
  insightTitle: string | null;
  insightSummary: string | null;
  runUuid: string | null;
  runType: string | null;
  runStartedAt: string | null;
};

export type RecommendationsResponse = {
  recommendations: RecommendationRow[];
};

export type LatestReportResponse = {
  reportType: 'llm_analysis' | 'daily_home_summary';
  analysisResultId: number;
  agentRunId: number | null;
  runUuid: string | null;
  publishedAt: string;
  markdown: string;
  payload: Record<string, unknown>;
};

export type RecentEventRow = {
  id: number;
  eventTime: string;
  eventType: string;
  domain: string | null;
  entityId: string | null;
  service: string | null;
  contextId: string | null;
  parentContextId: string | null;
  userId: string | null;
  collectorInstance: string;
  payloadPreview: string;
};

export type RecentEventsResponse = {
  events: RecentEventRow[];
};

export type AnomalyCard = {
  analysisResultId: number;
  runUuid: string | null;
  targetDay: string | null;
  publishedAt: string;
  metric: string;
  value: number;
  baselineMean: number;
  delta: number;
  zScore: number | null;
};

export type RecentAnomaliesResponse = {
  anomalies: AnomalyCard[];
};

export type ResourceUsageReading = {
  entityId: string;
  readingNumeric: number | null;
  readingText: string;
  unit: string | null;
  metadata: Record<string, unknown>;
  capturedAt: string;
};

export type ResourceUsageResponse = {
  capturedAt: string | null;
  byType: Record<'energy' | 'water' | 'gas' | 'power', ResourceUsageReading[]>;
};

export type AutomationSnapshotRow = {
  id: number;
  automationId: string;
  alias: string | null;
  isEnabled: boolean | null;
  triggerConfig: unknown[];
  actionConfig: unknown[];
  conditionsConfig: unknown[];
  metadata: Record<string, unknown>;
  capturedAt: string;
  createdAt: string;
};

export type AutomationSnapshotsResponse = {
  capturedAt: string | null;
  total: number;
  snapshots: AutomationSnapshotRow[];
};

export type EnvironmentSnapshotType =
  | 'automation'
  | 'script'
  | 'scene'
  | 'blueprint'
  | 'device'
  | 'service'
  | 'integration'
  | 'addon';

export type EnvironmentSnapshotRow = {
  id: number;
  snapshotType: EnvironmentSnapshotType | string;
  resourceId: string;
  label: string | null;
  metadata: Record<string, unknown>;
  capturedAt: string;
  createdAt: string;
};

export type EnvironmentSnapshotsResponse = {
  snapshotType: EnvironmentSnapshotType | string;
  capturedAt: string | null;
  total: number;
  snapshots: EnvironmentSnapshotRow[];
};

export type EntitySnapshotRow = {
  id: number;
  entityId: string;
  state: string | null;
  domain: string | null;
  attributes: Record<string, unknown>;
  contextId: string | null;
  capturedAt: string;
  sourceEventId: number | null;
  createdAt: string;
};

export type EntitySnapshotsResponse = {
  total: number;
  latestCapturedAt: string | null;
  snapshots: EntitySnapshotRow[];
};

export type HealthResponse = {
  ok: boolean;
  serverTime: string;
  dbTime: string | null;
  dbConnected: boolean;
  version: string;
};

export type ActionAcceptedResponse = {
  operation: ActionOperation;
};

export type RecommendationUpdateRequest = {
  status: Extract<RecommendationStatus, 'accepted' | 'rejected'>;
};

export type RecommendationUpdateResponse = {
  recommendation: RecommendationRow;
};
