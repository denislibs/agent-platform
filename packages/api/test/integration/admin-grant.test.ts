import { afterAll, expect, test } from 'bun:test';
import { NotFoundError } from '@agent/core';
import { grantCredits } from '../../src';
import { setupRealApi } from './helpers';

const api = setupRealApi();
afterAll(() => api.dispose());

test('grants credits on the real ledger: email is case-insensitive, balance adds up exactly', async () => {
  const { user } = await api.signIn(500);
  const { ledger } = api.container.cradle;
  expect(await grantCredits({ ledger }, [user.email.toUpperCase(), '0.1'])).toBe(
    `granted 0.1 credits to ${user.email}; balance 0.6 credits`,
  );
  expect(await grantCredits({ ledger }, [user.email, '0.2'])).toContain('balance 0.8 credits');
  expect(await ledger.balance(user.id)).toBe(800);
});

test('an unknown email is NotFoundError on the real database', async () => {
  const { ledger } = api.container.cradle;
  await expect(grantCredits({ ledger }, [`${crypto.randomUUID()}@test.dev`, '1'])).rejects.toBeInstanceOf(
    NotFoundError,
  );
});
