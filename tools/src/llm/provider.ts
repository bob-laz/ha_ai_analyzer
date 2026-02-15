import type { AgentOutput, AnalysisPromptInput } from './types.js';

export interface LLMProvider {
  analyze(input: AnalysisPromptInput): Promise<AgentOutput>;
}
