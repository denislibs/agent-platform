import { errorMessage, type Step } from '@agent/core';
import { isTerminalTask, type TaskStatus } from '@agent/shared';
import type { ApiDeps } from './deps';
import { realTimers, settlesWithin, type Timers } from './timing';

/** Куда стрим пишет: SSE в бою, что угодно в тестах. */
export interface StepSink {
  readonly closed: boolean;
  /** Слушатель закрытия (клиент ушёл, сервер останавливается); если приёмник уже закрыт — вызывается сразу. */
  onClose(listener: () => void): void;
  send(step: Step): Promise<void>;
  ping(): Promise<void>;
  end(status: TaskStatus): Promise<void>;
}

/**
 * Сколько ждать SUBSCRIBE (и UNSUBSCRIBE), прежде чем идти дальше без него. При недоступном Valkey команда
 * висит в очереди ioredis сколько угодно, а стрим не должен: он читает ленту по сердцебиению.
 */
export const SUBSCRIBE_TIMEOUT_MS = 2000;

const idle = (): void => {};

/**
 * Живая лента шагов (спецификация 10): уведомление, затем чтение.
 * 1. Подписка до первого чтения: уведомление между чтением и подпиской не потеряется. Подписку ждём не дольше
 *    `subscribeTimeoutMs`: если Valkey недоступен, стрим идёт на одном сердцебиении (с предупреждением в журнал),
 *    а подписка, пришедшая позже, подключается и сразу запускает перечитывание.
 * 2. Статус задачи читается до шагов: если задача уже финальная, все её шаги закоммичены и попадут в это чтение.
 * 3. Ждём уведомления или тика сердцебиения; на тике — ": ping" клиенту и перечитывание (pub/sub может терять).
 * Номер из уведомления не используется: уведомления теряются и приходят не по порядку, поэтому это лишь сигнал
 * «перечитай». Читаем всегда `seq > lastSent` из хранилища, по одному чтению за раз: уведомления, пришедшие во время
 * чтения, схлопываются во флаг signalled и дают ровно один следующий круг.
 * После end или закрытия приёмника не остаётся ни подписки, ни таймера.
 */
export async function streamTaskSteps(
  deps: Pick<ApiDeps, 'tasks' | 'steps' | 'stepEvents' | 'logger'>,
  opts: {
    taskId: string;
    afterSeq: number;
    heartbeatMs: number;
    sink: StepSink;
    subscribeTimeoutMs?: number;
    timers?: Timers;
  },
): Promise<void> {
  const { taskId, heartbeatMs, sink } = opts;
  const timers = opts.timers ?? realTimers;
  const subscribeTimeoutMs = opts.subscribeTimeoutMs ?? SUBSCRIBE_TIMEOUT_MS;
  if (sink.closed) return;

  let lastSent = opts.afterSeq;
  let signalled = false;
  let wake: () => void = idle;
  const notify = () => {
    signalled = true;
    wake();
  };

  let finished = false;
  let unsubscribe: (() => Promise<void>) | undefined;
  const release = async (off: () => Promise<void>): Promise<void> => {
    const done = off().catch(err =>
      deps.logger.warn('step stream unsubscribe failed', { taskId, error: errorMessage(err) }),
    );
    if (!(await settlesWithin(done, subscribeTimeoutMs, timers)))
      deps.logger.warn('step stream unsubscribe is slow; not waiting for it', { taskId });
  };
  const subscribed = deps.stepEvents.subscribe(taskId, notify).then(
    off => {
      // Стрим закончился раньше, чем заработала подписка: она уже никому не нужна.
      if (finished) return release(off);
      unsubscribe = off;
      // Пришла после тайм-аута — между нашими чтениями и подпиской уведомления могли пропасть: перечитываем.
      // Пришла вовремя — флаг сбросится перед первым чтением, лишнего круга не будет.
      notify();
    },
    err =>
      deps.logger.warn('step stream subscribe failed; polling on the heartbeat', { taskId, error: errorMessage(err) }),
  );
  if (!(await settlesWithin(subscribed, subscribeTimeoutMs, timers)))
    deps.logger.warn('step stream subscribe is slow; polling on the heartbeat until it is ready', {
      taskId,
      waitedMs: subscribeTimeoutMs,
    });

  sink.onClose(notify);
  try {
    while (!sink.closed) {
      signalled = false;
      const task = await deps.tasks.get(taskId);
      for (const step of await deps.steps.list(taskId, { afterSeq: lastSent })) {
        if (sink.closed) return;
        await sink.send(step);
        lastSent = step.seq;
      }
      if (!task || sink.closed) return;
      if (isTerminalTask(task.status)) {
        await sink.end(task.status);
        return;
      }
      if (signalled) continue;
      const timedOut = await new Promise<boolean>(resolve => {
        const handle = timers.set(() => resolve(true), heartbeatMs);
        wake = () => {
          timers.clear(handle);
          resolve(false);
        };
      });
      wake = idle;
      if (timedOut && !sink.closed) await sink.ping();
    }
  } finally {
    finished = true;
    wake = idle;
    const off = unsubscribe;
    unsubscribe = undefined;
    if (off) await release(off);
  }
}
