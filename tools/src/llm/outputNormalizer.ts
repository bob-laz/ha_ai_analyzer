import { agentOutputSchema } from '../agentOutputSchema.js';
import type { AgentOutput, NormalizedAgentOutput, NormalizedInsight, NormalizedRecommendation } from './types.js';

export class AgentOutputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentOutputValidationError';
  }
}

const clamp01 = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  if (parsed < 0) {
    return 0;
  }
  if (parsed > 1) {
    return 1;
  }
  return parsed;
};

const asString = (value: unknown, field: string): string => {
  if (typeof value !== 'string') {
    throw new AgentOutputValidationError(`${field} must be a string`);
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new AgentOutputValidationError(`${field} must not be empty`);
  }

  return trimmed;
};

const asOptionalString = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const asInteger = (value: unknown): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.floor(parsed);
};

const parseInsight = (raw: unknown, fallbackRank: number): NormalizedInsight => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AgentOutputValidationError('ranked_insights items must be objects');
  }

  const insight = raw as Record<string, unknown>;
  const rank = asInteger(insight.rank) ?? fallbackRank;
  const title = asString(insight.title, 'ranked_insights[].title');
  const description = asOptionalString(insight.description) ?? title;
  const rootCause = asString(insight.root_cause, 'ranked_insights[].root_cause');

  const evidence = Array.isArray(insight.evidence_ids)
    ? insight.evidence_ids
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter((item) => item.length > 0)
    : [];

  if (evidence.length === 0) {
    throw new AgentOutputValidationError('ranked_insights[].evidence_ids must contain at least one id');
  }

  return {
    rank,
    category: asOptionalString(insight.category) ?? 'general',
    title,
    summary: description,
    rootCause,
    confidence: clamp01(insight.confidence),
    severity: insight.severity === undefined ? null : clamp01(insight.severity),
    evidenceIds: [...new Set(evidence)],
  };
};

const parseRecommendation = (raw: unknown): NormalizedRecommendation => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AgentOutputValidationError('proposed_automation_changes items must be objects');
  }

  const recommendation = raw as Record<string, unknown>;

  return {
    automationId: asString(recommendation.automation_id, 'proposed_automation_changes[].automation_id'),
    changeType: asString(recommendation.change_type, 'proposed_automation_changes[].change_type'),
    reasoning: asString(recommendation.reasoning, 'proposed_automation_changes[].reasoning'),
    proposedYamlPatch: asOptionalString(recommendation.proposed_yaml_patch),
    estimatedImpact: asOptionalString(recommendation.estimated_impact),
    relatedInsightRank: asInteger(recommendation.related_insight_rank),
  };
};

function assertTopLevel(output: unknown): asserts output is AgentOutput {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new AgentOutputValidationError('LLM output must be a JSON object');
  }

  const required = agentOutputSchema.required;
  for (const key of required) {
    if (!(key in (output as Record<string, unknown>))) {
      throw new AgentOutputValidationError(`Missing required key '${key}' in LLM output`);
    }
  }
}

export const normalizeAgentOutput = (
  output: unknown,
  options: {
    expectedRunId: string;
    generatedAt: string;
    maxInsights: number;
  },
): NormalizedAgentOutput => {
  assertTopLevel(output);

  const raw = output as Record<string, unknown>;
  const runId = asOptionalString(raw.run_id) ?? options.expectedRunId;
  const generatedAt = asOptionalString(raw.generated_at) ?? options.generatedAt;

  const rankedRaw = Array.isArray(raw.ranked_insights) ? raw.ranked_insights : [];
  if (rankedRaw.length === 0) {
    throw new AgentOutputValidationError('ranked_insights must include at least one insight');
  }

  const rankedInsights = rankedRaw
    .map((insight, index) => parseInsight(insight, index + 1))
    .sort((a, b) => a.rank - b.rank)
    .slice(0, Math.max(1, options.maxInsights));

  const changesRaw = Array.isArray(raw.proposed_automation_changes) ? raw.proposed_automation_changes : [];
  const proposedAutomationChanges = changesRaw.map((change) => parseRecommendation(change));

  return {
    runId,
    generatedAt,
    summary: asOptionalString(raw.summary) ?? rankedInsights[0]?.summary ?? 'No summary provided by model.',
    rankedInsights,
    proposedAutomationChanges,
  };
};
