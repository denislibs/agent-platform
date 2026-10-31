import { NotFoundError, type TxRepositories, type UnitOfWork } from '@agent/core';
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
 * Записи вне run, сделанные параллельно с ним, при откате тоже теряются — в юнит-тестах так не делают.
 */
export class InMemoryUnitOfWork implements UnitOfWork {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly deps: { memory: InMemoryState }) {}

  async run<T>(fn: (tx: TxRepositories) => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => {
      release = resolve;
    });
    await previous;
    const memory = this.deps.memory;
    const snapshot = memory.snapshot();
    try {
      return await fn({
        tasks: new InMemoryTaskRepository(this.deps),
        steps: new InMemoryStepLog(this.deps),
        subtasks: new InMemorySubtaskRepository(this.deps),
        ledger: new InMemoryCreditLedger(this.deps),
        files: new InMemoryFileRepository(this.deps),
        lockUser: async userId => {
          if (!memory.users.has(userId)) throw new NotFoundError('user', userId);
        },
      });
    } catch (err) {
      memory.restore(snapshot);
      throw err;
    } finally {
      release();
    }
  }
}
