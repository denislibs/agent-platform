import { errorMessage, LogMailer, type Logger, type Mailer } from '@agent/core';
import { mapError } from './errors';

/** Предел idleTimeout в Bun.serve, секунды. */
const BUN_MAX_IDLE_TIMEOUT_SEC = 255;
const MIN_IDLE_TIMEOUT_SEC = 30;

/**
 * Bun закрывает соединение после 10 с тишины; SSE пингует раз в SSE_HEARTBEAT_MS — тайм-аут вдвое больше
 * интервала сердцебиения (в секундах), не меньше 30 и не больше предела Bun.
 */
export function idleTimeoutSec(sseHeartbeatMs: number): number {
  return Math.min(BUN_MAX_IDLE_TIMEOUT_SEC, Math.max(MIN_IDLE_TIMEOUT_SEC, Math.ceil(sseHeartbeatMs / 500)));
}

/**
 * Последний рубеж перед Bun.serve. Hono отдаёт в onError только экземпляры Error: `throw 'text'` или чужой
 * объект улетает из app.fetch, и Bun ответил бы своей текстовой страницей. Здесь такой ответ — тот же
 * конверт `{ error: { code: 'internal' } }`; текст ошибки — только в журнал.
 */
export function withJsonErrors<A extends unknown[]>(
  fetch: (req: Request, ...rest: A) => Response | Promise<Response>,
  logger: Logger,
): (req: Request, ...rest: A) => Promise<Response> {
  return async (req, ...rest) => {
    try {
      return await fetch(req, ...rest);
    } catch (err) {
      logger.error('unhandled API error', {
        method: req.method,
        path: new URL(req.url).pathname,
        error: errorMessage(err),
      });
      return Response.json(mapError(err).body, { status: 500 });
    }
  };
}

/**
 * Решение плана: пока нет почтового провайдера, magic link пишется в журнал. В продакшене об этом
 * предупреждаем при старте, чтобы не пригласить пользователей, которым письма не дойдут.
 */
export function warnIfMailIsLogged(deps: { mailer: Mailer; logger: Logger }, nodeEnv: string | undefined): void {
  if (nodeEnv === 'production' && deps.mailer instanceof LogMailer)
    deps.logger.warn('magic links are written to the log: configure a mail provider before inviting users (backlog)');
}
