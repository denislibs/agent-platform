import { AsyncLocalStorage } from 'node:async_hooks';
import { CallQueue, NotFoundError, sequential, type TxRepositories, type UnitOfWork } from '@agent/core';
import {
  InMemoryCreditLedger,
  InMemoryFileRepository,
  InMemoryStepLog,
  InMemorySubtaskRepository,
  InMemoryTaskRepository,
} from './repositories';
import type { InMemoryState } from './state';

/**
 * Транзакции in-memory: run выполняются строго по очереди (это сильнее, чем блокировка пользователя в Postgres,
 * и делает тесты детерминированными); при ошибке состояние откатывается из снимка.
 * Вызовы на tx внутри одного run тоже идут по одному, как в DrizzleUnitOfWork.
 * Вложенный run (из того же асинхронного контекста) бросает сразу: иначе он ждал бы в очереди за внешним вечно.
 * Записи вне run, сделанные параллельно с ним, при откате тоже теряются — в юнит-тестах так не делают.
 */
export class InMemoryUnitOfWork implements UnitOfWork {
  private tail: Promise<void> = Promise.resolve();
  /** Метка текущего run в асинхронном контексте; active снимается, когда run завершился. */
  private readonly current = new AsyncLocalStorage<{ active: boolean }>();

  constructor(private readonly deps: { memory: InMemoryState }) {}

  async run<T>(fn: (tx: TxRepositories) => Promise<T>): Promise<T> {
    if (this.current.getStore()?.active) throw new Error('UnitOfWork.run cannot be nested: use the tx passed to fn');
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => {
      release = resolve;
    });
    await previous;
    const memory = this.deps.memory;
    const snapshot = memory.snapshot();
    const queue = new CallQueue();
    const tx: TxRepositories = {
      tasks: sequential(new InMemoryTaskRepository(this.deps), queue),
      steps: sequential(new InMemoryStepLog(this.deps), queue),
      subtasks: sequential(new InMemorySubtaskRepository(this.deps), queue),
      ledger: sequential(new InMemoryCreditLedger(this.deps), queue),
      files: sequential(new InMemoryFileRepository(this.deps), queue),
      lockUser: userId =>
        queue.run(async () => {
          if (!memory.users.has(userId)) throw new NotFoundError('user', userId);
        }),
    };
    const mark = { active: true };
    try {
      return await this.current.run(mark, () => fn(tx));
    } catch (err) {
      memory.restore(snapshot);
      throw err;
    } finally {
      mark.active = false;
      release();
    }
  }
}
