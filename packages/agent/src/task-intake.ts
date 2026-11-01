import { errorMessage, LimitExceededError, type JobQueue, type Logger, type Task, type UnitOfWork } from '@agent/core';
import type { Config } from '@agent/shared';
import { jobKey } from './agent';

export interface NewTaskInput {
  userId: string;
  prompt: string;
  /** Загруженные заранее входные файлы (POST /api/uploads); чужие и уже привязанные молча пропускаются. */
  fileIds?: string[];
}

/**
 * Приём новой задачи (спецификация 4.1, шаг 1): проверка лимитов, задача в статусе queued, первый шаг
 * с запросом пользователя, `currentKind = 'plan'` и привязка входных файлов — одной транзакцией.
 * После коммита ставится job `plan`.
 */
export class TaskIntake {
  constructor(private readonly deps: { uow: UnitOfWork; config: Config; queue: JobQueue; logger: Logger }) {}

  async create(input: NewTaskInput): Promise<Task> {
    const { userId, prompt } = input;
    const fileIds = input.fileIds ?? [];
    const maxActive = this.deps.config.limits.maxActiveTasksPerUser;
    const created = await this.deps.uow.run(async tx => {
      await tx.lockUser(userId);
      if ((await tx.tasks.countActive(userId)) >= maxActive) {
        throw new LimitExceededError('active_tasks', `at most ${maxActive} active tasks per user`);
      }
      if ((await tx.ledger.balance(userId)) <= 0) {
        throw new LimitExceededError('credits', 'not enough credits to start a task');
      }
      const task = await tx.tasks.create({ userId, prompt });
      await tx.steps.append({
        taskId: task.id,
        agent: 'user',
        payload: { type: 'message', role: 'user', text: prompt },
      });
      if (fileIds.length > 0) await tx.files.attachToTask(fileIds, userId, task.id);
      await tx.tasks.update(task.id, { currentKind: 'plan' });
      const fresh = await tx.tasks.get(task.id);
      if (!fresh) throw new Error(`task ${task.id} vanished inside its own transaction`);
      return fresh;
    });
    // Шаг записан — теперь job (спецификация 8). Сбой постановки не теряет задачу: сборщик поставит plan сам.
    await this.deps.queue
      .enqueue({ taskId: created.id, kind: 'plan' }, jobKey(created.id, 'plan', created.lastSeq))
      .catch(err =>
        this.deps.logger.warn('could not queue the plan job; the sweeper will retry', {
          taskId: created.id,
          error: errorMessage(err),
        }),
      );
    return created;
  }
}
