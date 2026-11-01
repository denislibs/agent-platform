import { HTTPException } from 'hono/http-exception';
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

/** Хвост сообщения DrizzleQueryError (`params: …`) — значения запроса: токены сессий, ссылки magic link, промпты. */
const PARAMS_TAIL = /\bparams:[\s\S]*$/i;

/** Вырезает из текста ошибки хвост `params: …`: в журнал не должны попасть значения запроса. */
export const scrub = (text: string): string => text.replace(PARAMS_TAIL, 'params: <redacted>');

/**
 * Поля журнала для непредвиденной ошибки: текст и стек без хвоста `params: …`. В стеке очищается только
 * заголовок с сообщением, кадры остаются; если сообщения в стеке нет, очищается весь стек.
 */
export function errorLogFields(err: unknown): { error: string; stack?: string } {
  if (!(err instanceof Error)) return { error: scrub(String(err)) };
  const error = scrub(err.message);
  if (!err.stack) return { error };
  const stack =
    err.message !== '' && err.stack.includes(err.message)
      ? err.stack.replace(err.message, () => error)
      : scrub(err.stack);
  return { error, stack };
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
  if (err instanceof HTTPException && err.status < 500) return mapHttpException(err.status);
  return { status: 500, body: body('internal', 'internal error') };
}

/** Исключения самого Hono (bodyLimit и др.): код по статусу, текст фиксированный, `err.message` не показываем. */
function mapHttpException(status: ContentfulStatusCode): { status: ContentfulStatusCode; body: ApiErrorBody } {
  switch (status) {
    case 401:
      return { status, body: body('unauthorized', 'sign in to continue') };
    // csrf: изменяющий запрос с чужого Origin.
    case 403:
      return { status, body: body('forbidden', 'the request did not come from this site') };
    case 404:
      return { status, body: body('not_found', 'not found') };
    case 413:
      return { status, body: body('payload_too_large', 'payload too large') };
    default:
      return { status, body: body('bad_request', 'bad request') };
  }
}
