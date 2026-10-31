import { eq } from 'drizzle-orm';
import { NotFoundError, type TxRepositories, type UnitOfWork } from '@agent/core';
import type { Db, DbHandle } from '../client';
import { user } from '../schema';
import { DrizzleFileRepository } from './files';
import { DrizzleCreditLedger } from './ledger';
import { DrizzleStepLog } from './steps';
import { DrizzleSubtaskRepository } from './subtasks';
import { DrizzleTaskRepository } from './tasks';

/**
 * Репозитории получают транзакцию вместо пула. Их собственные db.transaction(...) внутри
 * становятся точками сохранения (SAVEPOINT) этой транзакции.
 */
export class DrizzleUnitOfWork implements UnitOfWork {
  constructor(private readonly deps: { database: DbHandle }) {}

  run<T>(fn: (tx: TxRepositories) => Promise<T>): Promise<T> {
    return this.deps.database.db.transaction(async tx => {
      // У транзакции тот же API запросов, что у базы; close здесь не нужен — пулом владеет внешний DbHandle.
      const database: DbHandle = { db: tx as unknown as Db, close: async () => {} };
      const deps = { database };
      return fn({
        tasks: new DrizzleTaskRepository(deps),
        steps: new DrizzleStepLog(deps),
        subtasks: new DrizzleSubtaskRepository(deps),
        ledger: new DrizzleCreditLedger(deps),
        files: new DrizzleFileRepository(deps),
        lockUser: async userId => {
          const [row] = await tx.select({ id: user.id }).from(user).where(eq(user.id, userId)).for('update');
          if (!row) throw new NotFoundError('user', userId);
        },
      });
    });
  }
}
