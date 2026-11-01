import {
  errorMessage,
  InvalidTransitionError,
  type JobQueue,
  type Logger,
  type SandboxProvider,
  type Task,
  type TaskRepository,
} from '@agent/core';
import { isTerminalTask, type Config, type JobKind } from '@agent/shared';
import { answeredAfterLastPause, type TaskGuard } from './guard';
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
 * waiting_user за проход — не больше 100 старейших: при сотнях неотвеченных пауз задача с ответом может ждать (backlog).
 */
export class Sweeper {
  constructor(
    private readonly deps: {
      tasks: TaskRepository;
      sandboxes: SandboxProvider;
      queue: JobQueue;
      guard: TaskGuard;
      config: Config;
      logger: Logger;
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

  /**
   * Зависшие задачи: тот же job, что ведёт их дальше; живой job с тем же ключом очередь не повторит.
   * waiting_user с ответом: ответ записан, а его job не поставился (сбой Valkey после коммита в API) — без этого
   * задача висела бы до тайм-аута ожидания. Ключ — по lastSeq с ответом, как ставит API.
   */
  private async requeueStale(): Promise<PassResult> {
    const { tasks, queue, config } = this.deps;
    const result: PassResult = { count: 0, failed: 0 };
    const stale = await tasks.findStale({
      statuses: ['queued', 'planning', 'running', 'finalizing'],
      staleForMs: config.worker.staleTaskMs,
    });
    const waiting = await tasks.findStale({ statuses: ['waiting_user'], staleForMs: config.worker.staleTaskMs });
    for (const task of [...stale, ...waiting]) {
      try {
        const kind = await this.kindToRequeue(task);
        if (!kind) continue;
        await queue.enqueue({ taskId: task.id, kind }, jobKey(task.id, kind, task.lastSeq));
        result.count++;
      } catch (err) {
        result.failed++; // подхватит следующий проход
        this.deps.logger.warn('sweeper could not re-queue a task', { taskId: task.id, error: errorMessage(err) });
      }
    }
    return result;
  }

  private async kindToRequeue(task: Task): Promise<JobKind | undefined> {
    if (task.status !== 'waiting_user') return kindForStatus(task.status, task.currentKind);
    if (!task.currentKind) return undefined;
    return (await this.deps.guard.hasAnswer(task.id)) ? task.currentKind : undefined;
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
        // Ответ пользователя не меняет статус: он лишь шаг, а паузу снимет job через guard.resume. Такую задачу
        // не трогаем. Проверка — в транзакции перехода и после него: переход (expectedFrom: waiting_user) берёт
        // блокировку строки задачи, которую ждёт запись ответа. Ответ, закоммиченный раньше, виден проверке, и
        // переход откатывается; ответ после нашего коммита перечитает статус, увидит finalizing и получит 409.
        // Если задачу тем временем возобновили или отменили, переход не пройдёт (InvalidTransitionError).
        const finalizing = await guard.toFinalizing(
          task.id,
          'waiting_user',
          { partial: true, stopReason: 'wait_timeout' },
          'wait_timeout',
          { unless: async tx => answeredAfterLastPause(await tx.steps.list(task.id)) },
        );
        if (!finalizing) continue;
        // Ключ job — по lastSeq после перехода: в нём уже шаг status.
        const after = await tasks.get(task.id);
        if (!after) continue;
        await queue.enqueue({ taskId: task.id, kind: 'finalize' }, jobKey(task.id, 'finalize', after.lastSeq));
        result.count++;
      } catch (err) {
        // Задачу уже ведёт другой job — это не сбой.
        if (err instanceof InvalidTransitionError) continue;
        result.failed++;
        this.deps.logger.warn('sweeper could not time out a waiting task', {
          taskId: task.id,
          error: errorMessage(err),
        });
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
      } catch (err) {
        result.failed++; // следующий проход попробует снова
        this.deps.logger.warn('sweeper could not destroy a sandbox', {
          sandboxId: info.id,
          taskId: info.taskId,
          error: errorMessage(err),
        });
      }
    }
    return result;
  }
}
