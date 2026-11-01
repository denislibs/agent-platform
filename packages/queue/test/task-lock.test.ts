import { afterAll, beforeAll, expect, test } from 'bun:test';
import type IORedis from 'ioredis';
import { loadConfig } from '@agent/shared';
import { redisConnection, TaskLock } from '../src';

let redis: IORedis;
beforeAll(() => {
  redis = redisConnection(loadConfig().valkeyUrl);
});
afterAll(async () => {
  await redis.quit();
});
const id = () => `lock-test-${crypto.randomUUID()}`;

test('only one holder at a time; the owner releases', async () => {
  const lock = new TaskLock({ redis });
  const task = id();
  const a = await lock.acquire(task);
  expect(a).toBeString();
  expect(await lock.acquire(task)).toBeUndefined();
  await lock.release(task, a!);
  expect(await lock.acquire(task)).toBeString();
});

test('a stranger cannot release or extend the lock', async () => {
  const lock = new TaskLock({ redis });
  const task = id();
  const a = (await lock.acquire(task))!;
  await lock.release(task, 'not-the-token');
  expect(await lock.acquire(task)).toBeUndefined();
  expect(await lock.extend(task, 'not-the-token')).toBe(false);
  expect(await lock.extend(task, a)).toBe(true);
});

test('an abandoned lock expires', async () => {
  const lock = new TaskLock({ redis, ttlMs: 150 });
  const task = id();
  expect(await lock.acquire(task)).toBeString();
  await Bun.sleep(300);
  expect(await lock.acquire(task)).toBeString();
});
