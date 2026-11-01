import type { JobQueue, SandboxProvider, TaskRepository } from '@agent/core';
import { isTerminalTask, type Config } from '@agent/shared';
import type { TaskGuard } from './guard';
import { jobKey, kindForStatus } from './jobs';

/**
 * Сборщик (спецификация 8, 4.2): раз в SWEEP_EVERY_MS — зависшие задачи, тайм-аут ответа, песочницы-сироты.
 * Ошибка на одной задаче или песочнице не прерывает проход: остальные обрабатываются, а недоделанное подхватит следующий.
 */
export class Sweeper {
  constructor(
    private readonly deps: {
      tasks: TaskRepository;
      sandboxes: SandboxProvider;
      queue: JobQueue;
      guard: TaskGuard;
      config: Config;
    },
  ) {}

  async sweep(): Promise<{ requeued: number; timedOut: number; destroyed: number }> {
    const requeued = await this.requeueStale();
    const timedOut = await this.timeOutWaiting();
    const destroyed = await this.destroyOrphans();
    return { requeued, timedOut, destroyed };
  }

  /** Зависшие задачи: тот же job, что ведёт их дальше; живой job с тем же ключом очередь не повторит. */
  private async requeueStale(): Promise<number> {
    const { tasks, queue, config } = this.deps;
    let requeued = 0;
    for (const task of await tasks.findStale({
      statuses: ['queued', 'planning', 'running', 'finalizing'],
      staleForMs: config.worker.staleTaskMs,
    })) {
      const kind = kindForStatus(task.status, task.currentKind);
      if (!kind) continue;
      try {
        await queue.enqueue({ taskId: task.id, kind }, jobKey(task.id, kind, task.lastSeq));
        requeued++;
      } catch {
        // Очередь недоступна для этой задачи: её подхватит следующий проход.
      }
    }
    return requeued;
  }

  /** Пользователь не ответил за WAIT_USER_TIMEOUT_MS: задача завершается с частичным результатом. */
  private async timeOutWaiting(): Promise<number> {
    const { tasks, queue, guard, config } = this.deps;
    let timedOut = 0;
    for (const task of await tasks.findStale({
      statuses: ['waiting_user'],
      staleForMs: config.limits.waitUserTimeoutMs,
    })) {
      try {
        // stopForLimit принимает и running: если пользователь успел ответить, задачу не трогаем.
        const current = await tasks.get(task.id);
        if (current?.status !== 'waiting_user') continue;
        const outcome = await guard.stopForLimitOrStop(current, 'wait_timeout');
        if (outcome.next !== 'finalize') continue;
        // Ключ job — по lastSeq после перехода: в нём уже шаг status.
        const after = await tasks.get(task.id);
        if (after)
          await queue.enqueue({ taskId: task.id, kind: 'finalize' }, jobKey(task.id, 'finalize', after.lastSeq));
        timedOut++;
      } catch {
        // Например, пользователь ответил между выборкой и переходом: задачу ведёт другой job.
      }
    }
    return timedOut;
  }

  /** Песочницы задач, которых нет или которые завершились. */
  private async destroyOrphans(): Promise<number> {
    const { tasks, sandboxes } = this.deps;
    let destroyed = 0;
    for (const info of await sandboxes.list()) {
      try {
        const task = await tasks.get(info.taskId);
        if (task && !isTerminalTask(task.status)) continue;
        await (await sandboxes.get(info.id))?.destroy();
        destroyed++;
      } catch {
        // Песочница не уничтожилась: следующий проход попробует снова.
      }
    }
    return destroyed;
  }
}
