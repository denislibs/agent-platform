import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Queue } from 'bullmq';
import type { JobRunner, Sweeper } from '@agent/agent';
import { InvalidTransitionError, type AgentJob, type TaskRepository } from '@agent/core';
import { AGENT_QUEUE, BullJobQueue, TaskLock, redisConnection, type RedisConnection } from '@agent/queue';
import { loadConfig } from '@agent/shared';
import { EXHAUST_ATTEMPTS, LOCK_RETRY_MS, startWorker, type RunningWorker } from '../src';

// Одна попытка на job: первая же ошибка исчерпывает его. Свой префикс — чужих job тест не видит.
const config = loadConfig({
  ...process.env,
  QUEUE_PREFIX: `exh-${crypto.randomUUID()}`,
  JOB_ATTEMPTS: '1',
  SWEEP_EVERY_MS: '3600000',
});

/** Настоящая блокировка, но для задач из busy после первого захвата всегда занята (её держит «другой job»). */
class BusyAfterRunLock extends TaskLock {
  readonly busy = new Set<string>();
  readonly acquired: string[] = [];
  override async acquire(taskId: string): Promise<string | undefined> {
    this.acquired.push(taskId);
    if (this.busy.has(taskId) && this.acquired.filter(id => id === taskId).length > 1) return undefined;
    return super.acquire(taskId);
  }
}

const runs: string[] = [];
const exhausted: AgentJob[] = [];
/** Держал ли job блокировку задачи, когда выполнялся onExhausted (проверка — отдельным захватом). */
const lockHeldOnExhaust = new Map<string, boolean>();
const throwingExhaust = new Set<string>();
const fatalRun = new Set<string>();
const okRun = new Set<string>();
let probe: TaskLock;
const runner = {
  run: async (job: AgentJob) => {
    runs.push(job.taskId);
    if (okRun.has(job.taskId)) return { next: 'stop' };
    if (fatalRun.has(job.taskId)) throw new InvalidTransitionError('task', job.taskId, 'running');
    throw new Error('boom');
  },
  onExhausted: async (job: AgentJob) => {
    exhausted.push(job);
    const token = await probe.acquire(job.taskId);
    if (token) await probe.release(job.taskId, token);
    lockHeldOnExhaust.set(job.taskId, token === undefined);
    if (throwingExhaust.has(job.taskId)) throw new Error('database down');
  },
} as unknown as JobRunner;
/** lastSeq задач для пропуска дублей; задачи вне карты считаются неизвестными, и job выполняется. */
const lastSeqs = new Map<string, number>();
const tasks = {
  get: async (id: string) => (lastSeqs.has(id) ? { id, lastSeq: lastSeqs.get(id) } : undefined),
} as unknown as TaskRepository;
const sweeper = { sweep: async () => ({ requeued: 0, timedOut: 0, destroyed: 0, failed: 0 }) } as unknown as Sweeper;

let redis: RedisConnection;
let queue: BullJobQueue;
let raw: Queue;
let lock: BusyAfterRunLock;
let worker: RunningWorker;

beforeAll(async () => {
  redis = redisConnection(config.valkeyUrl);
  queue = new BullJobQueue({ redis, config });
  raw = new Queue(AGENT_QUEUE, { connection: redis, prefix: config.worker.queuePrefix });
  lock = new BusyAfterRunLock({ redis });
  probe = new TaskLock({ redis });
  worker = await startWorker({ config, runner, sweeper, tasks, queue, taskLock: lock });
});
afterAll(async () => {
  await worker?.close();
  await raw.obliterate({ force: true });
  await raw.close();
  await queue.close();
  await redis.quit();
});

async function waitFor(ok: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!(await ok())) {
    if (Date.now() > until) throw new Error('timed out');
    await Bun.sleep(100);
  }
}

test('an exhausted job whose onExhausted ran stays failed', async () => {
  const taskId = crypto.randomUUID();
  await queue.enqueue({ taskId, kind: 'plan' }, `${taskId}.plan.1`);
  await waitFor(async () => (await raw.getJob(`${taskId}.plan.1`)?.then(j => j?.getState())) === 'failed');
  await waitFor(async () => exhausted.some(j => j.taskId === taskId));
  await Bun.sleep(200);
  expect(await (await raw.getJob(`${taskId}.plan.1`))?.getState()).toBe('failed');
});

test('the last attempt runs onExhausted once, still holding the task lock', async () => {
  const taskId = crypto.randomUUID();
  await queue.enqueue({ taskId, kind: 'plan' }, `${taskId}.plan.1`);
  await waitFor(async () => exhausted.some(j => j.taskId === taskId));
  await Bun.sleep(LOCK_RETRY_MS + 200);
  expect(lockHeldOnExhaust.get(taskId)).toBe(true);
  expect(exhausted.filter(j => j.taskId === taskId)).toHaveLength(1);
  // Только захват под run: failed-обработчик onExhausted не повторяет.
  expect(lock.acquired.filter(id => id === taskId)).toHaveLength(1);
});

test('a retryable error on every attempt exhausts the job under the lock of its last attempt', async () => {
  const taskId = crypto.randomUUID();
  await raw.add('plan', { taskId, kind: 'plan' }, { jobId: `${taskId}.plan.1`, attempts: 2, backoff: 10 });
  await waitFor(async () => (await raw.getJob(`${taskId}.plan.1`)?.then(j => j?.getState())) === 'failed');
  await waitFor(async () => exhausted.some(j => j.taskId === taskId));
  await Bun.sleep(LOCK_RETRY_MS + 200);
  expect(runs.filter(id => id === taskId)).toHaveLength(2);
  expect(exhausted.filter(j => j.taskId === taskId)).toHaveLength(1);
  expect(lockHeldOnExhaust.get(taskId)).toBe(true);
  // Блокировка той же попытки, а не новый захват после её снятия: по одному захвату на попытку.
  expect(lock.acquired.filter(id => id === taskId)).toHaveLength(2);
  expect((await raw.getJob(`${taskId}.plan.1`))?.attemptsMade).toBe(2);
});

test('a fatal error exhausts the job on its first attempt, under the lock', async () => {
  const taskId = crypto.randomUUID();
  fatalRun.add(taskId);
  await raw.add('plan', { taskId, kind: 'plan' }, { jobId: `${taskId}.plan.1`, attempts: 3, backoff: 10 });
  await waitFor(async () => (await raw.getJob(`${taskId}.plan.1`)?.then(j => j?.getState())) === 'failed');
  await waitFor(async () => exhausted.some(j => j.taskId === taskId));
  await Bun.sleep(LOCK_RETRY_MS + 200);
  expect(runs.filter(id => id === taskId)).toHaveLength(1);
  expect(exhausted.filter(j => j.taskId === taskId)).toHaveLength(1);
  expect(lockHeldOnExhaust.get(taskId)).toBe(true);
  expect(lock.acquired.filter(id => id === taskId)).toHaveLength(1);
});

test('a job is removed when onExhausted fails and the task lock then stays busy, freeing its key', async () => {
  const taskId = crypto.randomUUID();
  lock.busy.add(taskId);
  throwingExhaust.add(taskId);
  await queue.enqueue({ taskId, kind: 'plan' }, `${taskId}.plan.1`);
  await waitFor(async () => lock.acquired.filter(id => id === taskId).length > 0);
  await waitFor(async () => (await raw.getJob(`${taskId}.plan.1`)) === undefined);
  // Один захват на run (под ним onExhausted бросил) и EXHAUST_ATTEMPTS безуспешных в failed-обработчике.
  expect(lock.acquired.filter(id => id === taskId)).toHaveLength(1 + EXHAUST_ATTEMPTS);
  expect(exhausted.filter(j => j.taskId === taskId)).toHaveLength(1);
}, 20_000);

test('a job is removed when onExhausted keeps throwing', async () => {
  const taskId = crypto.randomUUID();
  throwingExhaust.add(taskId);
  await queue.enqueue({ taskId, kind: 'plan' }, `${taskId}.plan.1`);
  await waitFor(async () => exhausted.some(j => j.taskId === taskId));
  await waitFor(async () => (await raw.getJob(`${taskId}.plan.1`)) === undefined);
  // Одна попытка в процессоре и EXHAUST_ATTEMPTS в failed-обработчике.
  expect(exhausted.filter(j => j.taskId === taskId)).toHaveLength(1 + EXHAUST_ATTEMPTS);
}, 20_000);

test('a first run whose key seq is behind the task lastSeq is skipped as a duplicate', async () => {
  const taskId = crypto.randomUUID();
  okRun.add(taskId);
  lastSeqs.set(taskId, 7);
  await queue.enqueue({ taskId, kind: 'execute' }, `${taskId}.execute.5`);
  await waitFor(async () => lock.acquired.includes(taskId));
  await waitFor(async () => (await raw.getJob(`${taskId}.execute.5`)) === undefined);
  expect(runs).not.toContain(taskId);
  expect(exhausted.some(j => j.taskId === taskId)).toBe(false);

  // Ключ по текущему lastSeq (как у сборщика для простаивающей задачи) выполняется.
  await queue.enqueue({ taskId, kind: 'execute' }, `${taskId}.execute.7`);
  await waitFor(async () => runs.includes(taskId));
});
