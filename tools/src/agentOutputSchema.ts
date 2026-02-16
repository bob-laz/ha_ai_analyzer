export const agentOutputSchema = {
  type: 'object',
  required: ['run_id', 'generated_at', 'ranked_insights', 'proposed_automation_changes'],
  properties: {
    run_id: { type: 'string' },
    generated_at: { type: 'string', format: 'date-time' },
    summary: { type: 'string' },
    ranked_insights: {
      type: 'array',
      items: {
        type: 'object',
        required: ['rank', 'title', 'confidence', 'evidence_ids', 'root_cause'],
        properties: {
          rank: { type: 'integer', minimum: 1 },
          title: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          severity: { type: 'number', minimum: 0, maximum: 1 },
          description: { type: 'string' },
          evidence_ids: { type: 'array', items: { type: 'string' } },
          root_cause: { type: 'string' },
        },
      },
    },
    proposed_automation_changes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['automation_id', 'change_type', 'reasoning', 'related_insight_rank'],
        properties: {
          automation_id: { type: 'string' },
          change_type: { type: 'string' },
          reasoning: { type: 'string' },
          proposed_yaml_patch: { type: 'string' },
          estimated_impact: { type: 'string' },
          related_insight_rank: { type: 'integer', minimum: 1 },
        },
      },
    },
  },
} as const;
