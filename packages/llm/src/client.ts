import OpenAI from 'openai';
import { LlmError, type ChatResult, type Llm, type Role, type ToolCall } from '@agent/core';
import { toLlmError } from './errors';

/** null — значение не задано в env (в схеме конфига они необязательны: API без LiteLLM обходится). */
export interface LlmConfig {
  baseURL: string | null;
  apiKey: string | null;
  models: Record<Role, string | null>;
  maxRetries?: number;
  timeoutMs?: number;
}

/** Все значения LiteLLM заданы — иначе понятная ошибка со списком переменных окружения. */
function requireConfigured(cfg: LlmConfig): { baseURL: string; apiKey: string; models: Record<Role, string> } {
  const { baseURL, apiKey } = cfg;
  const { planner, executor } = cfg.models;
  if (baseURL && apiKey && planner && executor) return { baseURL, apiKey, models: { planner, executor } };
  const missing = (
    [
      ['LITELLM_BASE_URL', baseURL],
      ['LITELLM_API_KEY', apiKey],
      ['PLANNER_MODEL', planner],
      ['EXECUTOR_MODEL', executor],
    ] as const
  )
    .filter(([, value]) => !value)
    .map(([name]) => name);
  throw new Error(`LiteLLM is not configured: set ${missing.join(', ')} (the worker cannot run agents without it)`);
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
 * Без LITELLM_BASE_URL, LITELLM_API_KEY или моделей бросает сразу, при создании, а не на первом запросе.
 */
export function createLlm(config: LlmConfig): Llm {
  const { baseURL, apiKey, models } = requireConfigured(config);
  const cfg = { ...config, baseURL, apiKey, models };
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
