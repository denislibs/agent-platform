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
 * Репозиторий из контейнера внутри run бросает ошибку (в Postgres такой вызов шёл бы мимо транзакции).
 * Записи вне run, сделанные параллельно с ним, при откате тоже теряются — в юнит-тестах так не делают.
 */
export class InMemoryUnitOfWork implements UnitOfWork {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly deps: { memory: InMemoryState }) {}

  async run<T>(fn: (tx: TxRepositories) => Promise<T>): Promise<T> {
    if (this.deps.memory.txScope.getStore()?.active)
      throw new Error('UnitOfWork.run cannot be nested: use the tx passed to fn');
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => {
      release = resolve;
    });
    await previous;
    const memory = this.deps.memory;
    const token = Symbol('uow-run');
    const snapshot = memory.snapshot();
    const queue = new CallQueue();
    const tx: TxRepositories = {
      tasks: sequential(new InMemoryTaskRepository(this.deps, token), queue),
      steps: sequential(new InMemoryStepLog(this.deps, token), queue),
      subtasks: sequential(new InMemorySubtaskRepository(this.deps, token), queue),
      ledger: sequential(new InMemoryCreditLedger(this.deps, token), queue),
      files: sequential(new InMemoryFileRepository(this.deps, token), queue),
      lockUser: userId =>
        queue.run(async () => {
          if (!memory.users.has(userId)) throw new NotFoundError('user', userId);
        }),
    };
    const mark = { active: true, token };
    try {
      return await memory.txScope.run(mark, () => fn(tx));
    } catch (err) {
      memory.restore(snapshot);
      throw err;
    } finally {
      mark.active = false;
      release();
    }
  }
}
