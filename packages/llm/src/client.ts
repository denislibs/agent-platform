import OpenAI from 'openai';
import { LlmError, type ChatResult, type Llm, type Role, type ToolCall } from '@agent/core';
import { toLlmError } from './errors';

export interface LlmConfig {
  baseURL: string;
  apiKey: string;
  models: Record<Role, string>;
  maxRetries?: number;
  timeoutMs?: number;
}

export function parseToolCall(id: string, name: string, rawArgs: string): ToolCall {
  try {
    return { id, name, rawArgs, args: JSON.parse(rawArgs.trim() === '' ? '{}' : rawArgs) };
  } catch (err) {
    return { id, name, rawArgs, args: undefined, parseError: (err as Error).message };
  }
}

/**
 * Клиент LiteLLM. SDK сам повторяет 408/409/429/5xx и сетевые сбои (maxRetries, по умолчанию 4 — спецификация 7);
 * после этого наружу уходит LlmError с retryable, по которому план 3d решает, повторять ли job.
 */
export function createLlm(cfg: LlmConfig): Llm {
  const client = new OpenAI({
    baseURL: cfg.baseURL,
    apiKey: cfg.apiKey,
    maxRetries: cfg.maxRetries ?? 4,
    timeout: cfg.timeoutMs ?? 120_000,
  });

  return {
    async chat(req): Promise<ChatResult> {
      const model = cfg.models[req.role];
      let res: OpenAI.Chat.Completions.ChatCompletion;
      try {
        res = await client.chat.completions.create({
          model,
          messages: req.messages,
          stream: false,
          ...(req.tools?.length
            ? {
                tools: req.tools.map(t => ({
                  type: 'function' as const,
                  function: { name: t.name, description: t.description, parameters: t.parameters },
                })),
                tool_choice: req.toolChoice ?? 'auto',
              }
            : {}),
          ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
        });
      } catch (err) {
        throw toLlmError(err, model) ?? err;
      }
      const choice = res.choices?.[0];
      if (!choice) throw new LlmError('unavailable', `${model}: the response has no choices`, true);
      const toolCalls = (choice.message.tool_calls ?? []).flatMap(tc =>
        tc.type === 'function' ? [parseToolCall(tc.id, tc.function.name, tc.function.arguments)] : [],
      );
      return {
        model: res.model || model,
        content: choice.message.content ?? null,
        toolCalls,
        finishReason: choice.finish_reason ?? 'unknown',
        usage: { inputTokens: res.usage?.prompt_tokens ?? 0, outputTokens: res.usage?.completion_tokens ?? 0 },
      };
    },
  };
}
