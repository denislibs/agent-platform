import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from 'openai';
import { LlmError } from '@agent/core';

const CONTEXT_LENGTH_RE = /context[_ ]length|maximum context|context window|too many tokens|prompt is too long/i;

/**
 * Ошибки SDK и сети → LlmError. Неизвестные ошибки (баги в нашем коде) возвращаются как undefined:
 * их нельзя маскировать под «модель недоступна».
 */
export function toLlmError(err: unknown, model: string): LlmError | undefined {
  if (err instanceof LlmError) return err;
  if (err instanceof APIConnectionTimeoutError) return new LlmError('timeout', `${model}: request timed out`, true);
  if (err instanceof APIConnectionError) return new LlmError('unavailable', `${model}: ${err.message}`, true);
  // APIUserAbortError — подкласс APIError, поэтому проверяется раньше: отмена запроса не вина запроса.
  if (err instanceof APIUserAbortError) return new LlmError('unavailable', `${model}: request aborted`, true);
  if (err instanceof APIError) {
    const status = err.status ?? 0;
    const message = `${model}: ${status} ${err.message}`;
    if (status === 429) return new LlmError('rate_limited', message, true);
    if (status === 401 || status === 403) return new LlmError('auth', message, false);
    if (status === 408 || status === 409 || status >= 500) return new LlmError('unavailable', message, true);
    if (status === 413 || CONTEXT_LENGTH_RE.test(err.message)) return new LlmError('context_length', message, false);
    return new LlmError('bad_request', message, false);
  }
  return undefined;
}
