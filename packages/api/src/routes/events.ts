import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { StreamEnd, StreamError } from '@agent/shared';
import type { ApiDeps, ApiEnv } from '../deps';
import { toStepDto } from '../dto';
import { ApiError, errorLogFields } from '../errors';
import type { OpenStreams } from '../open-streams';
import { ownTask } from '../ownership';
import { streamTaskSteps, type StepSink } from '../step-stream';

/** Last-Event-ID (переподключение EventSource) или ?after= (первое подключение клиента, у которого уже есть шаги). */
function afterSeqOf(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 0;
  if (!/^\d{1,9}$/.test(raw)) throw new ApiError(400, 'bad_request', 'Last-Event-ID and ?after= must be a step number');
  return Number(raw);
}

export function eventRoutes(app: Hono<ApiEnv>, deps: ApiDeps, streams: OpenStreams): void {
  app.get('/api/tasks/:id/events', async c => {
    // Владелец и номер шага проверяются до начала потока: ошибки — обычные JSON-ответы, чужая задача — 404.
    const task = await ownTask(deps.tasks, c.req.param('id'), c.get('user').id);
    // `||`, а не `??`: пустой Last-Event-ID (EventSource без событий шлёт его так) не перекрывает ?after=.
    const afterSeq = afterSeqOf(c.req.header('last-event-id') || c.req.query('after'));
    // nginx не буферизует ответ с этим заголовком (план 4b) — события уходят клиенту сразу.
    c.header('X-Accel-Buffering', 'no');
    return streamSSE(c, async stream => {
      // Hono 4.13: onAbort срабатывает, когда Bun отменяет тело ответа (клиент ушёл); запись после этого
      // не бросает (StreamingApi.write глотает ошибки), поэтому закрытие проверяем сами через sink.closed.
      let stopping = false;
      const listeners: Array<() => void> = [];
      const fireClose = () => {
        for (const listener of listeners.splice(0)) listener();
      };
      const sink: StepSink = {
        get closed() {
          return stopping || stream.aborted || stream.closed;
        },
        onClose: listener => {
          if (sink.closed) listener();
          else listeners.push(listener);
        },
        send: async step => {
          await stream.writeSSE({ event: 'step', id: String(step.seq), data: JSON.stringify(toStepDto(step)) });
        },
        ping: async () => {
          await stream.write(': ping\n\n');
        },
        end: async status => {
          const body: StreamEnd = { status };
          await stream.writeSSE({ event: 'end', data: JSON.stringify(body) });
        },
      };
      stream.onAbort(fireClose);
      // Остановка сервера: поток закрывается без end, EventSource переподключится с Last-Event-ID.
      const untrack = streams.track(() => {
        stopping = true;
        fireClose();
      });
      // Ошибки ловим сами: onError хелпера Hono отправил бы клиенту сырой err.message.
      try {
        await streamTaskSteps(deps, {
          taskId: task.id,
          afterSeq,
          heartbeatMs: deps.config.api.sseHeartbeatMs,
          maxStreamMs: deps.config.api.sseMaxStreamMs,
          sink,
        });
      } catch (err) {
        // В журнал — всегда, даже если клиент уже ушёл: запись в закрытый поток не бросает (см. выше), так что
        // сюда попадают сбои чтения из хранилища, а не уход клиента.
        deps.logger.error('step stream failed', { taskId: task.id, ...errorLogFields(err) });
        if (sink.closed) return;
        const body: StreamError = { code: 'internal', message: 'the stream failed; reconnect' };
        await stream.writeSSE({ event: 'stream_error', data: JSON.stringify(body) }).catch(() => undefined);
      } finally {
        untrack();
      }
    });
  });
}
