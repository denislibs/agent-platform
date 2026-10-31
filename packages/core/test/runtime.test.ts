import { expect, test } from 'bun:test';
import { CryptoIds, SystemClock } from '@agent/core';

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
