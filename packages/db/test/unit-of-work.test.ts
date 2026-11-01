import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { DrizzleQueryError } from 'drizzle-orm';
import { createDb, DrizzleCreditLedger, DrizzleUnitOfWork, type DbHandle } from '../src';
import { createTestUser, resetDb, setupTestDb, testDatabaseUrl } from './helpers';

/** SQLSTATE lock_not_available: ожидание блокировки дольше lock_timeout. */
const LOCK_TIMEOUT = '55P03';
const LOCK_TIMEOUT_MS = 300;

/** Ошибка Postgres доходит до вызывающего как есть, обёрнутая Drizzle в DrizzleQueryError. */
async function expectLockTimeout(p: Promise<unknown>): Promise<void> {
  await expect(p).rejects.toBeInstanceOf(DrizzleQueryError);
  await expect(p).rejects.toHaveProperty('cause.code', LOCK_TIMEOUT);
}

describe('DrizzleUnitOfWork misuse', () => {
  /** Пул с lock_timeout по умолчанию (10 с): быстрый отказ здесь — заслуга SET LOCAL в самом run. */
  let database: DbHandle;
  /** Пул с коротким lock_timeout: репозиторий из контейнера ждёт блокировку на соединении пула. */
  let shortPool: DbHandle;
  beforeAll(async () => {
    database = await setupTestDb();
    shortPool = createDb(testDatabaseUrl(), { lockTimeoutMs: LOCK_TIMEOUT_MS });
  });
  afterAll(async () => {
    await shortPool.close();
    await database.close();
  });
  beforeEach(async () => {
    await resetDb(database.db);
  });

  test('a root repository blocked by the run fails on lock_timeout instead of hanging', async () => {
    const { id: userId } = await createTestUser(database.db, { millicredits: 1000 });
    const uow = new DrizzleUnitOfWork({ database: shortPool, lockTimeoutMs: LOCK_TIMEOUT_MS });
    const rootLedger = new DrizzleCreditLedger({ database: shortPool });
    const started = performance.now();
    const p = uow.run(async tx => {
      await tx.lockUser(userId);
      await rootLedger.record({ userId, taskId: null, model: 'q', tokensIn: 1, tokensOut: 1, millicredits: 50 });
    });
    await expectLockTimeout(p);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(await rootLedger.balance(userId)).toBe(1000);
  });

  test('a nested run fails on lock_timeout instead of hanging', async () => {
    const { id: userId } = await createTestUser(database.db, { millicredits: 1000 });
    const uow = new DrizzleUnitOfWork({ database, lockTimeoutMs: LOCK_TIMEOUT_MS });
    const started = performance.now();
    const p = uow.run(async tx => {
      await tx.lockUser(userId);
      await uow.run(async inner => {
        await inner.lockUser(userId);
        await inner.ledger.record({ userId, taskId: null, model: 'q', tokensIn: 1, tokensOut: 1, millicredits: 50 });
      });
    });
    await expectLockTimeout(p);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(await new DrizzleCreditLedger({ database }).balance(userId)).toBe(1000);
  });

  test('lockTimeoutMs must be a positive integer', () => {
    for (const lockTimeoutMs of [0, -1, 1.5, Number.NaN]) {
      expect(() => new DrizzleUnitOfWork({ database, lockTimeoutMs })).toThrow(RangeError);
    }
  });
});
