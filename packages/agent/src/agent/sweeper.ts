import {
  errorMessage,
  InvalidTransitionError,
  type FileRepository,
  type FileStore,
  type JobQueue,
  type Logger,
  type SandboxProvider,
  type Clock,
  type Task,
  type TaskRepository,
  type UnitOfWork,
} from '@agent/core';
import { isTerminalTask, type Config, type JobKind } from '@agent/shared';
import { answeredAfterLastPause, StaleJobError, type TaskGuard } from './guard';
import { jobKey, kindForStatus } from './jobs';

/** Итог одного прохода: сколько обработано и сколько элементов упало с ошибкой. */
interface PassResult {
  count: number;
  failed: number;
}

/** Сколько мс назад задача закончилась; без finishedAt — по последнему обновлению. */
const finishedFor = (task: Task, now: Date): number => now.getTime() - (task.finishedAt ?? task.updatedAt).getTime();

/**
 * Сборщик (спецификация 8, 4.2): раз в SWEEP_EVERY_MS — зависшие задачи, тайм-аут ответа, песочницы законченных
 * и удалённых задач и входные файлы, которые объявили, но не привязали к задаче за UPLOAD_TTL_MS.
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
      files: FileRepository;
      fileStore: FileStore;
      uow: UnitOfWork;
      clock: Clock;
      config: Config;
      logger: Logger;
    },
  ) {}

  async sweep(): Promise<{
    requeued: number;
    timedOut: number;
    stopped: number;
    destroyed: number;
    uploads: number;
    failed: number;
  }> {
    const requeued = await this.requeueStale();
    const timedOut = await this.timeOutWaiting();
    const { stopped, destroyed, failed } = await this.reclaimSandboxes();
    const uploads = await this.removeStaleUploads();
    return {
      requeued: requeued.count,
      timedOut: timedOut.count,
      stopped,
      destroyed,
      uploads: uploads.count,
      failed: requeued.failed + timedOut.failed + failed + uploads.failed,
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
        await queue.enqueue({ taskId: task.id, kind, cycle: task.cycle }, jobKey(task.id, kind, task.lastSeq));
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
          task,
          'waiting_user',
          { partial: true, stopReason: 'wait_timeout' },
          'wait_timeout',
          { unless: async tx => answeredAfterLastPause(await tx.steps.list(task.id)) },
        );
        if (!finalizing) continue;
        // Ключ job — по lastSeq после перехода: в нём уже шаг status.
        const after = await tasks.get(task.id);
        if (!after) continue;
        await queue.enqueue(
          { taskId: task.id, kind: 'finalize', cycle: after.cycle },
          jobKey(task.id, 'finalize', after.lastSeq),
        );
        result.count++;
      } catch (err) {
        // Задачу уже ведёт другой job — это не сбой.
        if (err instanceof InvalidTransitionError || err instanceof StaleJobError) continue;
        result.failed++;
        this.deps.logger.warn('sweeper could not time out a waiting task', {
          taskId: task.id,
          error: errorMessage(err),
        });
      }
    }
    return result;
  }

  /**
   * Песочницы законченных и удалённых задач. Задачи нет или она закончилась больше SANDBOX_RETENTION_MS назад и не
   * открыта заново — песочница удаляется. Раньше срока она ждёт продолжения беседы остановленной. Работающую обычно
   * останавливает JobRunner, когда job кончился; эта остановка — запас на случай, когда job не дожил до своего конца
   * (сбой воркера, сбой Docker): поэтому не раньше STALE_TASK_MS после конца задачи. Если job отменённой задачи ещё
   * выполняет команду, она оборвётся, но результат придёт обычным (execRaw отдаёт код 137, а не ошибку), и шаг
   * tool_result может лечь в ленту уже после cancelled. Дальше job заканчивается на ближайшей проверке статуса
   * или на not_running следующего вызова (ToolExecutor бросает StaleJobError) и песочницу не поднимает.
   * Осталось окно: задачу открывают заново между чтением здесь и удалением. Тогда первый вызов инструмента поднимет
   * пустую песочницу, как при её пропаже посреди цикла.
   */
  private async reclaimSandboxes(): Promise<{ stopped: number; destroyed: number; failed: number }> {
    const { tasks, sandboxes, clock, config } = this.deps;
    const result = { stopped: 0, destroyed: 0, failed: 0 };
    for (const info of await sandboxes.list()) {
      try {
        const task = await tasks.get(info.taskId);
        if (task && !isTerminalTask(task.status)) continue;
        const sandbox = await sandboxes.get(info.id);
        if (!sandbox) continue;
        const age = task ? finishedFor(task, clock.now()) : Number.POSITIVE_INFINITY;
        if (age >= config.worker.sandboxRetentionMs) {
          await sandbox.destroy();
          result.destroyed++;
        } else if (info.running && age >= config.worker.staleTaskMs) {
          await sandbox.stop();
          result.stopped++;
        }
      } catch (err) {
        result.failed++; // следующий проход попробует снова
        this.deps.logger.warn('sweeper could not reclaim a sandbox', {
          sandboxId: info.id,
          taskId: info.taskId,
          error: errorMessage(err),
        });
      }
    }
    return result;
  }

  /**
   * Загрузки, которые так и не привязали к задаче (POST /api/uploads без POST /api/tasks): не больше 100 старейших
   * за проход. Каждая — в своей транзакции: строка блокируется (lockUnattached, только если файл всё ещё
   * не привязан), удаляется объект S3, затем запись. Привязка (TaskIntake) ждёт блокировку строки и после коммита
   * не находит файла — задача не создаётся (404). Сбой S3 откатывает транзакцию: запись остаётся, следующий проход
   * повторит, а ждавшая привязка проходит. Объекта, которого уже нет, удаление S3 не замечает. Выходные файлы
   * и привязанные входные сюда не попадают никогда. Транзакция открыта на время одного удаления объекта S3.
   */
  private async removeStaleUploads(): Promise<PassResult> {
    const { files, fileStore, uow, config, logger } = this.deps;
    const result: PassResult = { count: 0, failed: 0 };
    for (const file of await files.listUnattachedInputs({ olderThanMs: config.worker.uploadTtlMs })) {
      try {
        const removed = await uow.run(async tx => {
          const locked = await tx.files.lockUnattached(file.id);
          if (!locked) return false;
          await fileStore.delete(locked.storageKey);
          return tx.files.deleteUnattached(locked.id);
        });
        if (removed) result.count++;
      } catch (err) {
        result.failed++; // запись на месте: следующий проход попробует снова
        logger.warn('sweeper could not remove a stale upload', {
          fileId: file.id,
          storageKey: file.storageKey,
          error: errorMessage(err),
        });
      }
    }
    return result;
  }
}
