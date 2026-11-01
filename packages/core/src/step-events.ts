import { errorMessage } from './errors';
import type { AppendStepInput, Step } from './entities';
import type { Logger } from './ports/logger';
import type { StepLog } from './ports/repositories';
import type { StepEvents } from './ports/step-events';
import type { TxRepositories, UnitOfWork } from './ports/unit-of-work';

interface PublishDeps {
  events: StepEvents;
  logger: Logger;
}

/** Сбой публикации не отменяет записанный шаг: подписчики дочитают ленту по своему таймеру. */
async function announce(deps: PublishDeps, taskId: string, lastSeq: number): Promise<void> {
  try {
    await deps.events.publish(taskId, lastSeq);
  } catch (err) {
    deps.logger.warn('could not announce new steps', { taskId, lastSeq, error: errorMessage(err) });
  }
}

/** Лента шагов вне транзакции: каждый append сразу после записи объявляется подписчикам задачи. */
export class PublishingStepLog implements StepLog {
  constructor(private readonly deps: PublishDeps & { inner: StepLog }) {}

  async append(input: AppendStepInput): Promise<Step> {
    const step = await this.deps.inner.append(input);
    await announce(this.deps, step.taskId, step.seq);
    return step;
  }

  list(taskId: string, opts?: { afterSeq?: number; subtaskId?: string }): Promise<Step[]> {
    return this.deps.inner.list(taskId, opts);
  }
}

/**
 * Транзакция, которая после коммита объявляет последний seq каждой задачи, получившей шаги.
 * До коммита и при откате не объявляется ничего: подписчик прочитал бы ленту без этих шагов.
 */
export class PublishingUnitOfWork implements UnitOfWork {
  constructor(private readonly deps: PublishDeps & { inner: UnitOfWork }) {}

  async run<T>(fn: (tx: TxRepositories) => Promise<T>): Promise<T> {
    const touched = new Map<string, number>();
    const result = await this.deps.inner.run(tx => fn({ ...tx, steps: collecting(tx.steps, touched) }));
    for (const [taskId, lastSeq] of touched) await announce(this.deps, taskId, lastSeq);
    return result;
  }
}

function collecting(steps: StepLog, touched: Map<string, number>): StepLog {
  return {
    async append(input) {
      const step = await steps.append(input);
      touched.set(step.taskId, Math.max(touched.get(step.taskId) ?? 0, step.seq));
      return step;
    },
    list: (taskId, opts) => steps.list(taskId, opts),
  };
}
