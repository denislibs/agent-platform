import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Queue } from 'bullmq';
import type IORedis from 'ioredis';
import { loadConfig } from '@agent/shared';
import { AGENT_QUEUE, BullJobQueue, redisConnection } from '../src';

const base = loadConfig();
const config = { ...base, worker: { ...base.worker, queuePrefix: `t${crypto.randomUUID().slice(0, 8)}` } };
let redis: IORedis;
let queue: BullJobQueue;
let raw: Queue;

beforeAll(() => {
  redis = redisConnection(config.valkeyUrl);
  queue = new BullJobQueue({ redis, config });
  raw = new Queue(AGENT_QUEUE, { connection: redis, prefix: config.worker.queuePrefix });
});
afterAll(async () => {
  await raw.obliterate({ force: true });
  await raw.close();
  await queue.close();
  await redis.quit();
});

test('a job carries only taskId and kind, under its key, with retries configured', async () => {
  await queue.enqueue({ taskId: 'task-a', kind: 'plan' }, 'task-a.plan.1');
  const job = await raw.getJob('task-a.plan.1');
  expect(job?.name).toBe('plan');
  expect(job?.data).toEqual({ taskId: 'task-a', kind: 'plan' });
  expect(job?.opts.attempts).toBe(config.worker.jobAttempts);
  expect(job?.opts.backoff).toMatchObject({ type: 'exponential' });
});

test('enqueueing the same key twice while it is pending adds one job', async () => {
  await queue.enqueue({ taskId: 'task-b', kind: 'execute' }, 'task-b.execute.7');
  await queue.enqueue({ taskId: 'task-b', kind: 'execute' }, 'task-b.execute.7');
  const waiting = await raw.getJobs(['waiting']);
  expect(waiting.filter(j => j.id === 'task-b.execute.7')).toHaveLength(1);
});

test('the sweep scheduler produces a sweep job', async () => {
  await queue.scheduleSweep(60_000);
  const schedulers = await raw.getJobSchedulers();
  expect(schedulers.map(s => s.key ?? s.id)).toContain('sweeper');
});
