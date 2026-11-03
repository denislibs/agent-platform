import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { inArray } from 'drizzle-orm';
import { StaleJobError, TaskGuard, TaskIntake } from '@agent/agent';
import type { Task } from '@agent/core';
import {
  createDb,
  DrizzleCreditLedger,
  DrizzleStepLog,
  DrizzleTaskRepository,
  DrizzleUnitOfWork,
  runMigrations,
  user,
  type DbHandle,
} from '@agent/db';
import { currentCycle } from '@agent/shared';
import { CapturingLogger, FixedClock, InMemoryJobQueue, testConfig } from '@agent/testing';

/*
 * Открытие законченной задачи заново против job'а старого цикла — на настоящих блокировках Postgres. InMemoryUnitOfWork
 * гоняет транзакции по очереди, и его lockTask ничего не блокирует: там эти гонки не воспроизвести. Базы *_test, без
 * Docker: песочница и модель не нужны, работают только TaskIntake, TaskGuard и репозитории Drizzle.
 */

/** Только база *_test: тест создаёт пользователей и задачи. */
function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set (see .env.test)');
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  if (!name.endsWith('_test')) throw new Error(`refusing to use a non-test database: ${name}`);
  return url;
}

/** SQLSTATE: deadlock_detected и lock_not_available (ожидание блокировки дольше lock_timeout). */
const DEADLOCK = '40P01';
const LOCK_TIMEOUT = '55P03';
/** Достаточно, чтобы переждать удержание блокировки в тесте, и мало, чтобы взаимная блокировка не висела долго. */
const LOCK_TIMEOUT_MS = 5000;

const pgCode = (err: unknown): unknown => (err as { cause?: { code?: unknown } } | null)?.cause?.code;

/** Небольшой случайный сдвиг: чередование запросов от раунда к раунду разное. */
const jitter = () => Bun.sleep(Math.random() * 6);

const lateStep = (text: string) =>
  ({ taskId: '', agent: 'system', payload: { type: 'message', role: 'user', text, kind: 'note' } }) as const;

describe('reopening a task against a job of the old cycle (Postgres)', () => {
  let database: DbHandle;
  let tasks: DrizzleTaskRepository;
  let steps: DrizzleStepLog;
  let intake: TaskIntake;
  let guard: TaskGuard;
  let ledger: DrizzleCreditLedger;
  const clock = new FixedClock();
  const userIds: string[] = [];

  beforeAll(async () => {
    const url = testDatabaseUrl();
    await runMigrations(url);
    database = createDb(url);
    const deps = { database };
    tasks = new DrizzleTaskRepository(deps);
    steps = new DrizzleStepLog(deps);
    ledger = new DrizzleCreditLedger(deps);
    const uow = new DrizzleUnitOfWork({ database, lockTimeoutMs: LOCK_TIMEOUT_MS });
    const config = testConfig({ MAX_ACTIVE_TASKS_PER_USER: '20' });
    intake = new TaskIntake({ uow, config, queue: new InMemoryJobQueue(), logger: new CapturingLogger() });
    guard = new TaskGuard({ tasks, steps, ledger, uow, clock, config });
  });

  afterAll(async () => {
    // Задачи, шаги и файлы уходят каскадом.
    if (userIds.length > 0) await database.db.delete(user).where(inArray(user.id, userIds));
    await database.close();
  });

  async function newUser(): Promise<string> {
    const [row] = await database.db
      .insert(user)
      .values({
        id: crypto.randomUUID(),
        name: 'Reopen',
        email: `${crypto.randomUUID()}@test.dev`,
        millicredits: 1_000_000,
      })
      .returning({ id: user.id });
    userIds.push(row!.id);
    return row!.id;
  }

  /** Остановленная задача цикла 1: как после отмены. */
  async function cancelledTask(userId: string): Promise<Task> {
    const task = await intake.create({ userId, prompt: 'Report' });
    await tasks.transition(task.id, 'cancelled', { finishedAt: clock.now() });
    await steps.append({
      taskId: task.id,
      agent: 'user',
      payload: { type: 'status', from: task.status, to: 'cancelled' },
    });
    return (await tasks.get(task.id))!;
  }

  const texts = async (taskId: string) =>
    (await steps.list(taskId)).flatMap(s => (s.payload.type === 'message' ? [s.payload.text] : []));

  test('reopen waits for a write of the old job; the next write of that job is stale', async () => {
    const userId = await newUser();
    const old = await cancelledTask(userId);
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const held = guard.write(old, async tx => {
      await tx.steps.append({ ...lateStep('held write'), taskId: old.id });
      entered.resolve();
      await gate.promise;
    });
    await entered.promise;

    let reopened = false;
    const reopening = intake.reopen({ taskId: old.id, userId, text: 'Changed my mind' }).then(task => {
      reopened = true;
      return task;
    });
    await Bun.sleep(300);
    expect(reopened).toBe(false);
    expect((await tasks.get(old.id))?.cycle).toBe(1);

    gate.resolve();
    await held;
    expect(await reopening).toMatchObject({ cycle: 2, status: 'planning' });

    await expect(
      guard.write(old, tx => tx.steps.append({ ...lateStep('late write'), taskId: old.id })),
    ).rejects.toBeInstanceOf(StaleJobError);
    // Запись, дождавшаяся reopen, легла в цикл 1, запись после него отклонена: в новом цикле только запрос.
    expect(await texts(old.id)).toEqual(['Report', 'held write', 'Changed my mind']);
    expect(currentCycle(await steps.list(old.id)).map(s => s.payload.type)).toEqual(['status', 'message']);
  });

  test('a write with the old cycle after the reopen is rolled back and leaves no step', async () => {
    const userId = await newUser();
    const old = await cancelledTask(userId);
    await intake.reopen({ taskId: old.id, userId, text: 'Changed my mind' });
    const before = await steps.list(old.id);

    await expect(
      guard.write(old, async tx => {
        await tx.steps.append({ ...lateStep('stale write'), taskId: old.id });
      }),
    ).rejects.toBeInstanceOf(StaleJobError);

    expect(await steps.list(old.id)).toEqual(before);
    expect(await texts(old.id)).not.toContain('stale write');
    expect(await tasks.get(old.id)).toMatchObject({ cycle: 2, status: 'planning' });
  });

  test('reopen, a ledger charge and an owner-locked write run together without a deadlock or a lock timeout', async () => {
    const ROUNDS = 8;
    const TASKS_PER_ROUND = 3;
    for (let round = 0; round < ROUNDS; round++) {
      const userId = await newUser();
      const olds: Task[] = [];
      for (let i = 0; i < TASKS_PER_ROUND; i++) olds.push(await cancelledTask(userId));

      const work: Array<{ name: string; run: Promise<unknown> }> = [];
      for (const old of olds) {
        work.push({
          name: `reopen ${old.id}`,
          run: jitter().then(() => intake.reopen({ taskId: old.id, userId, text: 'Changed my mind' })),
        });
        work.push({
          name: `ledger ${old.id}`,
          run: jitter().then(() =>
            ledger.record({ userId, taskId: old.id, model: 'm', tokensIn: 3, tokensOut: 4, millicredits: 5 }),
          ),
        });
        // Запись с внешним ключом на пользователя: владелец блокируется раньше задачи, как у открытия заново.
        work.push({
          name: `file write ${old.id}`,
          run: jitter().then(() =>
            guard.write(
              old,
              async tx => {
                await tx.files.upsertOutput({
                  userId,
                  taskId: old.id,
                  path: 'outputs/report.md',
                  storageKey: `tasks/${old.id}/outputs/report.md`,
                  size: 1,
                  mime: 'text/markdown',
                });
                await tx.steps.append({ ...lateStep('file written'), taskId: old.id });
              },
              { lockUser: userId },
            ),
          ),
        });
        work.push({
          name: `step write ${old.id}`,
          run: jitter().then(() =>
            guard.write(old, tx => tx.steps.append({ ...lateStep('step written'), taskId: old.id })),
          ),
        });
      }

      const settled = await Promise.allSettled(work.map(w => w.run));
      settled.forEach((result, i) => {
        if (result.status === 'fulfilled') return;
        const code = pgCode(result.reason);
        expect(code, `${work[i]!.name}: ${String(result.reason)}`).not.toBe(DEADLOCK);
        expect(code, `${work[i]!.name}: ${String(result.reason)}`).not.toBe(LOCK_TIMEOUT);
        // Единственный допустимый отказ: job старого цикла опоздал.
        expect(work[i]!.name.startsWith('reopen') || work[i]!.name.startsWith('ledger')).toBe(false);
        expect(result.reason).toBeInstanceOf(StaleJobError);
      });

      for (const old of olds) {
        expect(await tasks.get(old.id)).toMatchObject({ cycle: 2, status: 'planning', tokensUsed: 7 });
        // В новом цикле: граница и запрос пользователя, ничего от job'а старого.
        expect(currentCycle(await steps.list(old.id)).map(s => s.payload.type)).toEqual(['status', 'message']);
      }
    }
  }, 60_000);
});
