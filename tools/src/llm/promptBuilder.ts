import { agentOutputSchema } from '../agentOutputSchema.js';
import type { AnalysisPromptInput } from './types.js';

export type BuiltPrompt = {
  systemPrompt: string;
  userPrompt: string;
};

export const buildAnalysisPrompt = (input: AnalysisPromptInput): BuiltPrompt => {
  const systemPrompt = [
    'You are a Home Assistant event analysis agent.',
    'Return only valid JSON, no markdown, no commentary, no code fences.',
    'Use only evidence_ids from the provided evidence catalog.',
    'Rank insights by operational importance and confidence.',
    'Recommendations are proposals only; do not assume automatic execution.',
  ].join(' ');

  const compactTraces = input.tracedContexts.map((bundle) => ({
    contextId: bundle.contextId,
    rootContextId: bundle.trace.rootContextId,
    events: bundle.trace.events,
  }));

  const userPayload = {
    objective:
      'Analyze the event window, identify top insights with explicit evidence IDs, and propose safe automation changes as drafts.',
    run: {
      run_id: input.runId,
      generated_at: input.generatedAt,
      window: input.window,
    },
    constraints: {
      max_insights: input.constraints.maxInsights,
      recommendation_policy: input.constraints.recommendationPolicy,
      output_must_match_schema: true,
    },
    aggregates: {
      daily_summary: input.dailySummary,
      top_changes: input.topChanges,
    },
    traced_contexts: compactTraces,
    evidence_catalog: input.evidenceCatalog,
    output_schema: agentOutputSchema,
  };

  return {
    systemPrompt,
    userPrompt: JSON.stringify(userPayload),
  };
};
