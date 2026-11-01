import { InvalidTransitionError, type JobQueue, type SandboxProvider, type TaskRepository } from '@agent/core';
import { isTerminalTask, type Config } from '@agent/shared';
import type { TaskGuard } from './guard';
import { jobKey, kindForStatus } from './jobs';

/** Итог одного прохода: сколько обработано и сколько элементов упало с ошибкой. */
interface PassResult {
  count: number;
  failed: number;
}

/**
 * Сборщик (спецификация 8, 4.2): раз в SWEEP_EVERY_MS — зависшие задачи, тайм-аут ответа, песочницы-сироты.
 * Ошибка на одной задаче или песочнице не прерывает проход: остальные обрабатываются, а недоделанное подхватит следующий.
 * Число таких ошибок — `failed` в результате: воркер пишет его в лог.
 * Выборка findStale — не больше 100 задач (старейшие первыми) на набор статусов за проход; остальные — в следующий.
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

  async sweep(): Promise<{ requeued: number; timedOut: number; destroyed: number; failed: number }> {
    const requeued = await this.requeueStale();
    const timedOut = await this.timeOutWaiting();
    const destroyed = await this.destroyOrphans();
    return {
      requeued: requeued.count,
      timedOut: timedOut.count,
      destroyed: destroyed.count,
      failed: requeued.failed + timedOut.failed + destroyed.failed,
    };
  }

  /** Зависшие задачи: тот же job, что ведёт их дальше; живой job с тем же ключом очередь не повторит. */
  private async requeueStale(): Promise<PassResult> {
    const { tasks, queue, config } = this.deps;
    const result: PassResult = { count: 0, failed: 0 };
    for (const task of await tasks.findStale({
      statuses: ['queued', 'planning', 'running', 'finalizing'],
      staleForMs: config.worker.staleTaskMs,
    })) {
      const kind = kindForStatus(task.status, task.currentKind);
      if (!kind) continue;
      try {
        await queue.enqueue({ taskId: task.id, kind }, jobKey(task.id, kind, task.lastSeq));
        result.count++;
      } catch {
        result.failed++; // подхватит следующий проход
      }
    }
    return result;
  }

  /** Пользователь не ответил за WAIT_USER_TIMEOUT_MS: задача завершается с частичным результатом. */
  private async timeOutWaiting(): Promise<PassResult> {
    const { tasks, queue, guard, config } = this.deps;
    const result: PassResult = { count: 0, failed: 0 };
    for (const task of await tasks.findStale({
      statuses: ['waiting_user'],
      staleForMs: config.limits.waitUserTimeoutMs,
    })) {
      try {
        // Ответ пользователя не меняет статус: он лишь шаг, а паузу снимет job через guard.resume. Такую задачу не трогаем.
        if (await guard.hasAnswer(task.id)) continue;
        // Переход атомарен (expectedFrom: waiting_user): если задачу тем временем возобновили или отменили, он не пройдёт.
        await guard.toFinalizing(
          task.id,
          'waiting_user',
          { partial: true, stopReason: 'wait_timeout' },
          'wait_timeout',
        );
        // Ключ job — по lastSeq после перехода: в нём уже шаг status.
        const after = await tasks.get(task.id);
        if (!after) continue;
        await queue.enqueue({ taskId: task.id, kind: 'finalize' }, jobKey(task.id, 'finalize', after.lastSeq));
        result.count++;
      } catch (err) {
        // Задачу уже ведёт другой job — это не сбой.
        if (!(err instanceof InvalidTransitionError)) result.failed++;
      }
    }
    return result;
  }

  /** Песочницы задач, которых нет или которые завершились. */
  private async destroyOrphans(): Promise<PassResult> {
    const { tasks, sandboxes } = this.deps;
    const result: PassResult = { count: 0, failed: 0 };
    for (const info of await sandboxes.list()) {
      try {
        const task = await tasks.get(info.taskId);
        if (task && !isTerminalTask(task.status)) continue;
        const sandbox = await sandboxes.get(info.id);
        if (!sandbox) continue;
        await sandbox.destroy();
        result.count++;
      } catch {
        result.failed++; // следующий проход попробует снова
      }
    }
    return result;
  }
}
