import { afterEach, expect, spyOn, test } from 'bun:test';
import {
  ConsoleLogger,
  CryptoIds,
  errorMessage,
  LogMailer,
  SystemClock,
  type LogFields,
  type Logger,
} from '@agent/core';

afterEach(() => {
  // spyOn из bun:test восстанавливается вручную.
  for (const m of ['log', 'warn', 'error'] as const) (console[m] as { mockRestore?: () => void }).mockRestore?.();
});

test('SystemClock returns the current time', () => {
  const before = Date.now();
  const now = new SystemClock().now().getTime();
  expect(now).toBeGreaterThanOrEqual(before);
  expect(now).toBeLessThanOrEqual(Date.now());
});

test('CryptoIds returns distinct v4 UUIDs', () => {
  const ids = new CryptoIds();
  const a = ids.uuid();
  expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(ids.uuid()).not.toBe(a);
});

test('ConsoleLogger prefixes the scope and appends fields as JSON', () => {
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  const log = spyOn(console, 'log').mockImplementation(() => {});
  new ConsoleLogger('api').warn('enqueue failed', { taskId: 't1' });
  new ConsoleLogger('api').info('ready');
  expect(warn).toHaveBeenCalledWith('[api] enqueue failed {"taskId":"t1"}');
  expect(log).toHaveBeenCalledWith('[api] ready');
});

test('ConsoleLogger survives fields that JSON cannot serialise', () => {
  const error = spyOn(console, 'error').mockImplementation(() => {});
  const loop: Record<string, unknown> = {};
  loop.self = loop;
  new ConsoleLogger().error('boom', loop);
  expect(error).toHaveBeenCalledWith('[app] boom [unserializable fields]');
});

test('LogMailer writes the message to the logger instead of sending it', async () => {
  const entries: Array<[string, LogFields | undefined]> = [];
  const logger: Logger = { info: (m, f) => entries.push([m, f]), warn: () => {}, error: () => {} };
  await new LogMailer({ logger }).send({ to: 'a@b.c', subject: 'Sign in', text: 'https://x/verify' });
  expect(entries).toEqual([
    ['mail not sent (no mail provider): logged instead', { to: 'a@b.c', subject: 'Sign in', text: 'https://x/verify' }],
  ]);
});

test('errorMessage takes the message of an Error and stringifies anything else', () => {
  expect(errorMessage(new Error('boom'))).toBe('boom');
  expect(errorMessage('plain')).toBe('plain');
  expect(errorMessage(42)).toBe('42');
});
