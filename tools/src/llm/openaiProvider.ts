import { setTimeout as sleep } from 'node:timers/promises';

import { buildAnalysisPrompt } from './promptBuilder.js';
import type { LLMProvider } from './provider.js';
import type { AgentOutput, AnalysisPromptInput } from './types.js';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export type OpenAIProviderConfig = {
  apiKey: string;
  model: string;
  timeoutMs: number;
  retryMaxAttempts: number;
  baseUrl?: string;
};

type OpenAIChatResponse = {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
  error?: {
    message?: string;
  };
};

const parseMessageContent = (response: OpenAIChatResponse): string => {
  const content = response.choices?.[0]?.message?.content;
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    const text = content
      .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
      .join('')
      .trim();
    if (text.length > 0) {
      return text;
    }
  }

  throw new Error('OpenAI response did not include model content');
};

const parseAgentOutput = (content: string): AgentOutput => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('OpenAI model content was not valid JSON');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('OpenAI model JSON must be an object');
  }

  return parsed as AgentOutput;
};

export class OpenAIProvider implements LLMProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly retryMaxAttempts: number;
  private readonly baseUrl: string;

  constructor(config: OpenAIProviderConfig) {
    this.apiKey = config.apiKey.trim();
    this.model = config.model.trim();
    this.timeoutMs = config.timeoutMs;
    this.retryMaxAttempts = config.retryMaxAttempts;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');

    if (!this.apiKey) {
      throw new Error('OPENAI_API_KEY is required for LLM_PROVIDER=openai');
    }

    if (!this.model) {
      throw new Error('LLM_MODEL must be set for LLM_PROVIDER=openai');
    }

    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error('LLM_REQUEST_TIMEOUT_MS must be a positive number');
    }

    if (!Number.isFinite(this.retryMaxAttempts) || this.retryMaxAttempts < 1) {
      throw new Error('LLM_RETRY_MAX_ATTEMPTS must be >= 1');
    }
  }

  async analyze(input: AnalysisPromptInput): Promise<AgentOutput> {
    const { systemPrompt, userPrompt } = buildAnalysisPrompt(input);

    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= this.retryMaxAttempts; attempt += 1) {
      try {
        return await this.requestCompletion(systemPrompt, userPrompt);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const canRetry = attempt < this.retryMaxAttempts && this.isRetryableError(lastError.message);
        if (!canRetry) {
          break;
        }

        const delayMs = Math.min(5000, 250 * 2 ** (attempt - 1));
        await sleep(delayMs);
      }
    }

    throw new Error(`OpenAI analysis failed: ${lastError?.message ?? 'unknown error'}`);
  }

  private isRetryableError(message: string): boolean {
    return message.startsWith('retryable_status:') || message.startsWith('network:') || message.startsWith('timeout:');
  }

  private async requestCompletion(systemPrompt: string, userPrompt: string): Promise<AgentOutput> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0.2,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
        }),
      });

      const bodyText = await response.text();
      let body: OpenAIChatResponse = {};
      if (bodyText.length > 0) {
        try {
          body = JSON.parse(bodyText) as OpenAIChatResponse;
        } catch {
          body = {};
        }
      }

      if (!response.ok) {
        const errorMessage = body.error?.message ?? `status ${response.status}`;
        if (RETRYABLE_STATUS.has(response.status)) {
          throw new Error(`retryable_status:${response.status}:${errorMessage}`);
        }
        throw new Error(`non_retryable_status:${response.status}:${errorMessage}`);
      }

      const content = parseMessageContent(body);
      return parseAgentOutput(content);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`timeout:${this.timeoutMs}`);
      }
      if (
        error instanceof Error &&
        (error.message.startsWith('retryable_status:') ||
          error.message.startsWith('non_retryable_status:') ||
          error.message.startsWith('timeout:'))
      ) {
        throw error;
      }
      throw new Error(`network:${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
