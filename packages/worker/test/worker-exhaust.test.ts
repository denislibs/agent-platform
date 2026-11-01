import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Queue } from 'bullmq';
import type { JobRunner, Sweeper } from '@agent/agent';
import type { AgentJob } from '@agent/core';
import { AGENT_QUEUE, BullJobQueue, TaskLock, redisConnection, type RedisConnection } from '@agent/queue';
import { loadConfig } from '@agent/shared';
import { EXHAUST_ATTEMPTS, startWorker, type RunningWorker } from '../src';

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

const exhausted: AgentJob[] = [];
const throwingExhaust = new Set<string>();
const runner = {
  run: async () => {
    throw new Error('boom');
  },
  onExhausted: async (job: AgentJob) => {
    exhausted.push(job);
    if (throwingExhaust.has(job.taskId)) throw new Error('database down');
  },
} as unknown as JobRunner;
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
  worker = await startWorker({ config, runner, sweeper, queue, taskLock: lock });
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

test('a job is removed when the task lock stays busy, freeing its key for the sweeper', async () => {
  const taskId = crypto.randomUUID();
  lock.busy.add(taskId);
  await queue.enqueue({ taskId, kind: 'plan' }, `${taskId}.plan.1`);
  await waitFor(async () => lock.acquired.filter(id => id === taskId).length > 0);
  await waitFor(async () => (await raw.getJob(`${taskId}.plan.1`)) === undefined);
  // Один захват на run и EXHAUST_ATTEMPTS безуспешных — под onExhausted.
  expect(lock.acquired.filter(id => id === taskId)).toHaveLength(1 + EXHAUST_ATTEMPTS);
  expect(exhausted.some(j => j.taskId === taskId)).toBe(false);
}, 20_000);

test('a job is removed when onExhausted keeps throwing', async () => {
  const taskId = crypto.randomUUID();
  throwingExhaust.add(taskId);
  await queue.enqueue({ taskId, kind: 'plan' }, `${taskId}.plan.1`);
  await waitFor(async () => exhausted.some(j => j.taskId === taskId));
  await waitFor(async () => (await raw.getJob(`${taskId}.plan.1`)) === undefined);
  expect(exhausted.filter(j => j.taskId === taskId)).toHaveLength(EXHAUST_ATTEMPTS);
}, 20_000);
