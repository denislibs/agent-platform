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

test('the profile is projected to id, email, name, image and theme only', async () => {
  const t = setupApi();
  const { user } = await t.signIn();
  const cookie = `session=${t.auth.signIn({ ...user, emailVerified: true, role: 'admin' } as typeof user)}`;
  const body = (await (await t.call('GET', '/api/me', { headers: { cookie } })).json()) as { user: object };
  expect(body.user).toEqual(user);
});

test('PATCH /api/me saves the theme in the profile; the next GET returns it', async () => {
  const t = setupApi();
  const { headers } = await t.signIn();
  const res = await t.call('PATCH', '/api/me', { headers, body: { theme: 'light' } });
  expect(res.status).toBe(200);
  expect(MeResponseSchema.parse(await res.json()).user.theme).toBe('light');
  const again = MeResponseSchema.parse(await (await t.call('GET', '/api/me', { headers })).json());
  expect(again.user.theme).toBe('light');
});

test('an unknown theme is 400 and the profile keeps its theme', async () => {
  const t = setupApi();
  const { headers } = await t.signIn();
  for (const body of [{ theme: 'neon' }, { theme: null }, {}]) {
    const res = await t.call('PATCH', '/api/me', { headers, body });
    expect(res.status).toBe(400);
  }
  const me = MeResponseSchema.parse(await (await t.call('GET', '/api/me', { headers })).json());
  expect(me.user.theme).toBe('dark');
});

test('PATCH /api/me needs a session and a JSON body', async () => {
  const t = setupApi();
  expect((await t.call('PATCH', '/api/me', { body: { theme: 'light' } })).status).toBe(401);
  const { headers } = await t.signIn();
  const form = await t.app.request('/api/me', {
    method: 'PATCH',
    headers: { ...headers, 'content-type': 'text/plain' },
    body: JSON.stringify({ theme: 'light' }),
  });
  expect(form.status).toBe(400);
});
