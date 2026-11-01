import { expect, test } from 'bun:test';
import { MeResponseSchema } from '@agent/shared';
import { setupApi } from './helpers';

test('GET /api/me returns the profile and the balance in credits', async () => {
  const t = setupApi();
  const { user, headers } = await t.signIn({ millicredits: 12_345 });
  const res = await t.call('GET', '/api/me', { headers });
  expect(res.status).toBe(200);
  expect(MeResponseSchema.parse(await res.json())).toEqual({
    user,
    balance: { millicredits: 12_345, credits: '12.345' },
  });
});

test('a negative balance is shown as is', async () => {
  const t = setupApi();
  const { headers } = await t.signIn({ millicredits: -250 });
  const body = MeResponseSchema.parse(await (await t.call('GET', '/api/me', { headers })).json());
  expect(body.balance).toEqual({ millicredits: -250, credits: '-0.25' });
});
