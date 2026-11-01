import { expect, test } from 'bun:test';
import { NotFoundError } from '@agent/core';
import { createTestContainer } from '@agent/testing';
import { grantCredits, GRANT_USAGE, UsageError } from '../../src';

test('grants credits by email as millicredits and reports the new balance', async () => {
  const c = createTestContainer().cradle;
  const id = c.memory.seedUser({ email: 'ann@test.dev', millicredits: 500 });
  expect(await grantCredits(c, ['Ann@Test.dev', '2.5'])).toBe('granted 2.5 credits to ann@test.dev; balance 3 credits');
  expect(await c.ledger.balance(id)).toBe(3000);
});

test('wrong arguments are a usage error; a bad amount is refused before the ledger is touched', async () => {
  const c = createTestContainer().cradle;
  const id = c.memory.seedUser({ email: 'ann@test.dev', millicredits: 0 });
  for (const args of [[], ['ann@test.dev'], ['ann@test.dev', '1', 'extra']]) {
    const p = grantCredits(c, args);
    await expect(p).rejects.toBeInstanceOf(UsageError);
    await expect(p).rejects.toThrow(GRANT_USAGE);
  }
  await expect(grantCredits(c, ['ann@test.dev', '0.0001'])).rejects.toBeInstanceOf(RangeError);
  expect(await c.ledger.balance(id)).toBe(0);
});

test('an unknown email is NotFoundError', async () => {
  const c = createTestContainer().cradle;
  await expect(grantCredits(c, ['nobody@test.dev', '1'])).rejects.toBeInstanceOf(NotFoundError);
});
