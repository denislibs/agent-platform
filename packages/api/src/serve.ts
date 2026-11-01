import { errorMessage, LogMailer, type Logger, type Mailer } from '@agent/core';
import { mapError } from './errors';
import type { OpenStreams } from './open-streams';
import { isLocalRuntime } from './runtime-env';
import { settlesWithin } from './timing';

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
 * Решение плана: пока нет почтового провайдера, magic link пишется в журнал. Вне test и development
 * (пустой NODE_ENV тоже) об этом предупреждаем при старте, чтобы не пригласить пользователей, которым письма не дойдут.
 */
export function warnIfMailIsLogged(deps: { mailer: Mailer; logger: Logger }, nodeEnv: string | undefined): void {
  if (!isLocalRuntime(nodeEnv) && deps.mailer instanceof LogMailer)
    deps.logger.warn('magic links are written to the log: configure a mail provider before inviting users (backlog)');
}

/** Сколько ждать штатного закрытия соединений при остановке, прежде чем рвать их (docker stop ждёт 10 с). */
export const SHUTDOWN_GRACE_MS = 5000;

/**
 * Остановка сервера. `server.stop()` перестаёт принимать соединения и ждёт открытые — а SSE-поток задачи
 * сам не закрывается. Поэтому сначала закрываем учтённые потоки (клиенты переподключатся к другому экземпляру),
 * затем ждём штатного закрытия не дольше `graceMs` и рвём то, что осталось.
 */
export async function stopServer(
  server: { stop(closeActiveConnections?: boolean): Promise<void> },
  streams: OpenStreams,
  opts: { graceMs: number; logger: Logger },
): Promise<void> {
  const closed = streams.closeAll();
  if (closed > 0) opts.logger.info('closed open event streams', { streams: closed });
  const graceful = server.stop();
  if (await settlesWithin(graceful, opts.graceMs)) return graceful;
  opts.logger.warn('connections still open after the grace period; closing them by force', { graceMs: opts.graceMs });
  await server.stop(true);
}
