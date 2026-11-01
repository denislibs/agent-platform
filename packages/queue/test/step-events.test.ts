import { afterAll, expect, test } from 'bun:test';
import IORedis from 'ioredis';
import { loadConfig } from '@agent/shared';
import { stepEventsContract } from '@agent/testing';
import { redisConnection, stepChannel, ValkeyStepEvents, type RedisConnection } from '../src';

const url = loadConfig().valkeyUrl;

stepEventsContract('valkey', async () => {
  const redis = redisConnection(url);
  const events = new ValkeyStepEvents({ redis });
  return {
    events,
    close: async () => {
      await events.close();
      await redis.quit();
    },
  };
});

const redis = redisConnection(url);
const events = new ValkeyStepEvents({ redis });
afterAll(async () => {
  await events.close();
  await redis.quit();
});

test('notifications travel through the task:<id> channel, so another process can publish them', async () => {
  const taskId = crypto.randomUUID();
  const got: number[] = [];
  const off = await events.subscribe(taskId, seq => got.push(seq));
  expect(stepChannel(taskId)).toBe(`task:${taskId}`);
  await redis.publish(stepChannel(taskId), '7');
  for (let i = 0; i < 100 && got.length === 0; i++) await Bun.sleep(10);
  expect(got).toEqual([7]);
  await off();
});

test('the last unsubscribe leaves the channel; a later subscribe joins it again', async () => {
  const taskId = crypto.randomUUID();
  const off = await events.subscribe(taskId, () => {});
  expect(await redis.pubsub('NUMSUB', stepChannel(taskId))).toEqual([stepChannel(taskId), 1]);
  await off();
  expect(await redis.pubsub('NUMSUB', stepChannel(taskId))).toEqual([stepChannel(taskId), 0]);
  const got: number[] = [];
  const again = await events.subscribe(taskId, seq => got.push(seq));
  await events.publish(taskId, 2);
  for (let i = 0; i < 100 && got.length === 0; i++) await Bun.sleep(10);
  expect(got).toEqual([2]);
  await again();
});

test('a malformed message is ignored', async () => {
  const taskId = crypto.randomUUID();
  const got: number[] = [];
  const off = await events.subscribe(taskId, seq => got.push(seq));
  await redis.publish(stepChannel(taskId), 'not-a-number');
  await events.publish(taskId, 3);
  for (let i = 0; i < 100 && got.length === 0; i++) await Bun.sleep(10);
  expect(got).toEqual([3]);
  await off();
});

test('publish against a hung connection rejects within the bound instead of blocking the writer', async () => {
  const hung = { publish: () => new Promise<number>(() => {}) } as unknown as RedisConnection;
  const bounded = new ValkeyStepEvents({ redis: hung, publishTimeoutMs: 50 });
  const started = Date.now();
  await expect(bounded.publish(crypto.randomUUID(), 1)).rejects.toThrow(/timed out/);
  expect(Date.now() - started).toBeLessThan(1000);
});

test('publish against an unreachable Valkey (offline queue) rejects within the bound', async () => {
  // Порт 1 никто не слушает: команды копятся в offline queue ioredis и без предела висели бы бесконечно.
  const dead = new IORedis('redis://127.0.0.1:1', { maxRetriesPerRequest: null });
  dead.on('error', () => {});
  const bounded = new ValkeyStepEvents({ redis: dead, publishTimeoutMs: 100 });
  try {
    const started = Date.now();
    await expect(bounded.publish(crypto.randomUUID(), 1)).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(1500);
  } finally {
    dead.disconnect();
  }
});
