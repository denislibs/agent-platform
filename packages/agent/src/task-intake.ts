import {
  errorMessage,
  InvalidTransitionError,
  LimitExceededError,
  NotFoundError,
  type JobQueue,
  type Logger,
  type Task,
  type TxRepositories,
  type UnitOfWork,
} from '@agent/core';
import { currentCycle, isTerminalTask, type Config } from '@agent/shared';
import { jobKey } from './agent';

export interface NewTaskInput {
  userId: string;
  prompt: string;
  /**
   * Загруженные заранее входные файлы (POST /api/uploads). Повторы схлопываются; чужой, неизвестный или уже
   * привязанный файл — NotFoundError('file'), задача не создаётся.
   */
  fileIds?: string[];
}

/**
 * Приём работы (спецификация 4.1, шаг 1). Новая задача: проверка лимитов, задача в статусе queued, первый шаг
 * с запросом пользователя, `currentKind = 'plan'` и привязка входных файлов — одной транзакцией.
 * Продолжение законченной задачи — reopen. В обоих случаях после коммита ставится job `plan`.
 */
export class TaskIntake {
  constructor(private readonly deps: { uow: UnitOfWork; config: Config; queue: JobQueue; logger: Logger }) {}

  async create(input: NewTaskInput): Promise<Task> {
    const { userId, prompt } = input;
    const fileIds = [...new Set(input.fileIds ?? [])];
    const created = await this.deps.uow.run(async tx => {
      await tx.lockUser(userId);
      await this.assertCanStart(tx, userId);
      const task = await tx.tasks.create({ userId, prompt });
      await tx.steps.append({
        taskId: task.id,
        agent: 'user',
        payload: { type: 'message', role: 'user', text: prompt },
      });
      if (fileIds.length > 0) {
        const attached = await tx.files.attachToTask(fileIds, userId, task.id);
        // Чужой, неизвестный или уже привязанный файл: откат всей транзакции, задача не создаётся.
        if (attached !== fileIds.length) throw new NotFoundError('file', fileIds.join(','));
      }
      await tx.tasks.update(task.id, { currentKind: 'plan' });
      const fresh = await tx.tasks.get(task.id);
      if (!fresh) throw new Error(`task ${task.id} vanished inside its own transaction`);
      return fresh;
    });
    await this.enqueuePlan(created);
    return created;
  }

  /**
   * Продолжение законченной задачи (спецификация 4.2): новое сообщение открывает её заново одной транзакцией с теми же
   * проверками, что у новой задачи. Цикл растёт, база лимитов — текущий расход, итог прошлого цикла очищается.
   * Шаг status идёт раньше сообщения: он граница цикла (isReopenStep), и сообщение остаётся внутри нового цикла.
   * Подзадачи, которые прошлый цикл не довёл до конца (отмена, сбой), закрываются: иначе исполнитель подхватил бы их.
   * Ответ задачи, законченной до плана 9, есть только в result: он записывается шагом, иначе пропал бы из ленты.
   * Гонка с другим открытием или с job'ом: блокировка пользователя и строки задачи, затем переход с expectedFrom.
   */
  async reopen(input: { taskId: string; userId: string; text: string }): Promise<Task> {
    const { taskId, userId, text } = input;
    const reopened = await this.deps.uow.run(async tx => {
      await tx.lockUser(userId);
      const before = await tx.lockTask(taskId);
      if (!before) throw new NotFoundError('task', taskId);
      if (!isTerminalTask(before.status)) throw new InvalidTransitionError('task', taskId, 'planning');
      await this.assertCanStart(tx, userId);
      const hasAnswer = currentCycle(await tx.steps.list(taskId)).some(
        s => s.payload.type === 'message' && s.payload.kind === 'answer',
      );
      if (before.status === 'done' && before.result !== null && !hasAnswer) {
        const files = (await tx.files.listForTask(taskId, 'output')).map(f => f.path);
        await tx.steps.append({
          taskId,
          agent: 'planner',
          payload: { type: 'message', role: 'assistant', text: before.result, kind: 'answer', files },
        });
      }
      for (const sub of await tx.subtasks.list(taskId)) {
        if (sub.status === 'pending') await tx.subtasks.transition(sub.id, 'skipped');
        else if (sub.status === 'running' || sub.status === 'reviewing') await tx.subtasks.transition(sub.id, 'failed');
      }
      await tx.tasks.transition(
        taskId,
        'planning',
        {
          currentKind: 'plan',
          finishedAt: null,
          partial: false,
          stopReason: null,
          result: null,
          cycle: before.cycle + 1,
          cycleBaseTokens: before.tokensUsed,
          cycleBaseActiveMs: before.activeMs,
        },
        { expectedFrom: before.status },
      );
      await tx.steps.append({
        taskId,
        agent: 'user',
        payload: { type: 'status', from: before.status, to: 'planning' },
      });
      await tx.steps.append({ taskId, agent: 'user', payload: { type: 'message', role: 'user', text } });
      const fresh = await tx.tasks.get(taskId);
      if (!fresh) throw new Error(`task ${taskId} vanished inside its own transaction`);
      return fresh;
    });
    await this.enqueuePlan(reopened);
    return reopened;
  }

  /** Проверки перед работой, под блокировкой пользователя: лимит активных задач и баланс. */
  private async assertCanStart(tx: TxRepositories, userId: string): Promise<void> {
    const maxActive = this.deps.config.limits.maxActiveTasksPerUser;
    if ((await tx.tasks.countActive(userId)) >= maxActive) {
      throw new LimitExceededError('active_tasks', `at most ${maxActive} active tasks per user`);
    }
    if ((await tx.ledger.balance(userId)) <= 0) {
      throw new LimitExceededError('credits', 'not enough credits to start a task');
    }
  }

  /** Шаг записан — теперь job (спецификация 8). Сбой постановки не теряет задачу: сборщик поставит plan сам. */
  private async enqueuePlan(task: Task): Promise<void> {
    await this.deps.queue.enqueue({ taskId: task.id, kind: 'plan' }, jobKey(task.id, 'plan', task.lastSeq)).catch(err =>
      this.deps.logger.warn('could not queue the plan job; the sweeper will retry', {
        taskId: task.id,
        error: errorMessage(err),
      }),
    );
  }
}
