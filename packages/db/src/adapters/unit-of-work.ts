import { eq, sql } from 'drizzle-orm';
import { CallQueue, NotFoundError, sequential, type TxRepositories, type UnitOfWork } from '@agent/core';
import { DEFAULT_LOCK_TIMEOUT_MS, type Db, type DbHandle } from '../client';
import { user } from '../schema';
import { DrizzleFileRepository } from './files';
import { DrizzleCreditLedger } from './ledger';
import { DrizzleStepLog } from './steps';
import { DrizzleSubtaskRepository } from './subtasks';
import { DrizzleTaskRepository } from './tasks';

/**
 * Репозитории получают транзакцию вместо пула. Их собственные db.transaction(...) внутри
 * становятся точками сохранения (SAVEPOINT) этой транзакции.
 *
 * Вызовы на tx идут строго по одному (CallQueue): параллельные точки сохранения на одном соединении
 * переплетаются, и откат одной из них молча стирает записи соседнего вызова.
 *
 * Первым запросом транзакция ставит SET LOCAL lock_timeout: вложенный run (другое соединение), который ждёт
 * блокировку внешнего, падает с ошибкой Postgres 55P03, а не висит вечно. Репозиторий из контейнера внутри run
 * ловит тот же lock_timeout пула (createDb). Ошибка не переводится в доменную — это признак неправильного
 * использования.
 */
export class DrizzleUnitOfWork implements UnitOfWork {
  private readonly lockTimeoutMs: number;

  constructor(private readonly deps: { database: DbHandle; lockTimeoutMs?: number }) {
    const ms = deps.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    if (!Number.isSafeInteger(ms) || ms <= 0)
      throw new RangeError(`lockTimeoutMs must be a positive integer, got ${ms}`);
    this.lockTimeoutMs = ms;
  }

  run<T>(fn: (tx: TxRepositories) => Promise<T>): Promise<T> {
    return this.deps.database.db.transaction(async tx => {
      // SET не принимает параметры; значение — проверенное в конструкторе целое число.
      await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${this.lockTimeoutMs}ms'`));
      // У транзакции тот же API запросов, что у базы; close здесь не нужен — пулом владеет внешний DbHandle.
      const database: DbHandle = { db: tx as unknown as Db, close: async () => {} };
      const deps = { database };
      const queue = new CallQueue();
      return fn({
        tasks: sequential(new DrizzleTaskRepository(deps), queue),
        steps: sequential(new DrizzleStepLog(deps), queue),
        subtasks: sequential(new DrizzleSubtaskRepository(deps), queue),
        ledger: sequential(new DrizzleCreditLedger(deps), queue),
        files: sequential(new DrizzleFileRepository(deps), queue),
        lockUser: userId =>
          queue.run(async () => {
            const [row] = await tx.select({ id: user.id }).from(user).where(eq(user.id, userId)).for('update');
            if (!row) throw new NotFoundError('user', userId);
          }),
      });
    });
  }
}
