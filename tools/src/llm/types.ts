import type { DailySummary, TopChangesResult, TraceContextResult } from '../agentTools.js';

export type AnalysisWindow = {
  start: string;
  end: string;
  timezone: string;
  hours: number;
};

export type EvidenceCatalogItem = {
  evidenceId: string;
  evidenceType: 'event' | 'top_change' | 'context' | 'unknown';
  eventId: number | null;
  entityId: string | null;
  contextId: string | null;
  payload: Record<string, unknown>;
};

export type TraceBundle = {
  contextId: string;
  trace: TraceContextResult;
};

export type AnalysisPromptInput = {
  runId: string;
  generatedAt: string;
  window: AnalysisWindow;
  dailySummary: DailySummary;
  topChanges: TopChangesResult;
  tracedContexts: TraceBundle[];
  evidenceCatalog: EvidenceCatalogItem[];
  constraints: {
    maxInsights: number;
    recommendationPolicy: 'propose_only';
  };
};

export type AgentInsightOutput = {
  rank: number;
  title: string;
  confidence: number;
  severity?: number;
  description?: string;
  root_cause: string;
  evidence_ids: string[];
  category?: string;
};

export type AgentRecommendationOutput = {
  automation_id: string;
  change_type: string;
  reasoning: string;
  proposed_yaml_patch?: string;
  estimated_impact?: string;
  related_insight_rank?: number;
};

export type AgentOutput = {
  run_id: string;
  generated_at: string;
  summary?: string;
  ranked_insights: AgentInsightOutput[];
  proposed_automation_changes: AgentRecommendationOutput[];
};

export type NormalizedInsight = {
  rank: number;
  category: string;
  title: string;
  summary: string;
  rootCause: string;
  confidence: number;
  severity: number | null;
  evidenceIds: string[];
};

export type NormalizedRecommendation = {
  automationId: string;
  changeType: string;
  reasoning: string;
  proposedYamlPatch: string | null;
  estimatedImpact: string | null;
  relatedInsightRank: number | null;
};

export type NormalizedAgentOutput = {
  runId: string;
  generatedAt: string;
  summary: string;
  rankedInsights: NormalizedInsight[];
  proposedAutomationChanges: NormalizedRecommendation[];
};
