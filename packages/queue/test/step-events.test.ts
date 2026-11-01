import { afterAll, expect, test } from 'bun:test';
import IORedis from 'ioredis';
import { loadConfig } from '@agent/shared';
import { CapturingLogger, stepEventsContract } from '@agent/testing';
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

test('a throwing handler does not stop the other handlers of the task and is logged', async () => {
  const logger = new CapturingLogger();
  const logged = new ValkeyStepEvents({ redis, logger });
  const uncaught: unknown[] = [];
  const onUncaught = (err: unknown) => uncaught.push(err);
  process.on('uncaughtException', onUncaught);
  try {
    const taskId = crypto.randomUUID();
    const got: number[] = [];
    const offBad = await logged.subscribe(taskId, () => {
      throw new Error('boom');
    });
    const offGood = await logged.subscribe(taskId, seq => got.push(seq));
    await logged.publish(taskId, 5);
    for (let i = 0; i < 100 && got.length === 0; i++) await Bun.sleep(10);
    expect(got).toEqual([5]);
    expect(uncaught).toEqual([]);
    expect(logger.entries.some(e => e.level === 'error' && e.message.includes('handler failed'))).toBe(true);
    await offBad();
    await offGood();
  } finally {
    process.off('uncaughtException', onUncaught);
    await logged.close();
  }
});

/** Подписочное соединение, чей первый SUBSCRIBE отклоняется. */
function flakySubscriberRedis(): { redis: RedisConnection; subscribeCalls: string[] } {
  const subscribeCalls: string[] = [];
  const sub = {
    on: () => sub,
    subscribe: async (name: string) => {
      subscribeCalls.push(name);
      if (subscribeCalls.length === 1) throw new Error('subscribe failed');
      return 1;
    },
    unsubscribe: async () => 0,
    quit: async () => 'OK',
  };
  return { redis: { duplicate: () => sub } as unknown as RedisConnection, subscribeCalls };
}

test('a rejected SUBSCRIBE does not poison later subscriptions of the task', async () => {
  const { redis: fake, subscribeCalls } = flakySubscriberRedis();
  const flaky = new ValkeyStepEvents({ redis: fake });
  const taskId = crypto.randomUUID();
  await expect(flaky.subscribe(taskId, () => {})).rejects.toThrow('subscribe failed');
  const off = await flaky.subscribe(taskId, () => {});
  expect(subscribeCalls).toEqual([stepChannel(taskId), stepChannel(taskId)]);
  await off();
  await flaky.close();
});

test('subscriber connection errors are logged, not left unhandled', async () => {
  const logger = new CapturingLogger();
  const listeners: Record<string, (err: Error) => void> = {};
  const sub = {
    on: (event: string, fn: (err: Error) => void) => {
      listeners[event] = fn;
      return sub;
    },
    subscribe: async () => 1,
    unsubscribe: async () => 0,
    quit: async () => 'OK',
  };
  const logged = new ValkeyStepEvents({ redis: { duplicate: () => sub } as unknown as RedisConnection, logger });
  await logged.subscribe(crypto.randomUUID(), () => {});
  listeners.error?.(new Error('ECONNRESET'));
  expect(logger.entries.some(e => e.level === 'warn' && JSON.stringify(e.fields).includes('ECONNRESET'))).toBe(true);
  await logged.close();
});
