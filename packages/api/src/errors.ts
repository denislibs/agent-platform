import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { InvalidTransitionError, LimitExceededError, NotFoundError } from '@agent/core';
import type { ApiErrorBody, ApiErrorCode } from '@agent/shared';

/** Ошибка с готовым ответом: статус, код и текст для клиента. */
export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const body = (code: ApiErrorCode, message: string): ApiErrorBody => ({ error: { code, message } });

/** Ошибка → ответ. Текст неизвестных ошибок клиенту не показывается: его пишет журнал (createApp). */
export function mapError(err: unknown): { status: ContentfulStatusCode; body: ApiErrorBody } {
  if (err instanceof ApiError) return { status: err.status, body: body(err.code, err.message) };
  // Ключ не показываем: чужой id не должен подтверждаться ни в каком виде.
  if (err instanceof NotFoundError) return { status: 404, body: body('not_found', `${err.entity} not found`) };
  if (err instanceof LimitExceededError)
    return err.limit === 'credits'
      ? { status: 402, body: body('insufficient_credits', err.message) }
      : { status: 429, body: body('too_many_active_tasks', err.message) };
  if (err instanceof InvalidTransitionError)
    return { status: 409, body: body('conflict', 'the task has changed its state; reload it') };
  return { status: 500, body: body('internal', 'internal error') };
}
