import { expect, test } from 'bun:test';
import { MeResponseSchema, UsageResponseSchema } from '@agent/shared';
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

test('PATCH /api/me saves a trimmed name; theme and name can come together or alone', async () => {
  const t = setupApi();
  const { headers } = await t.signIn();
  const res = await t.call('PATCH', '/api/me', { headers, body: { name: '  Ada Lovelace ' } });
  expect(res.status).toBe(200);
  const body = MeResponseSchema.parse(await res.json());
  expect(body.user).toMatchObject({ name: 'Ada Lovelace', theme: 'dark' });
  const both = await t.call('PATCH', '/api/me', { headers, body: { name: 'Ada', theme: 'light' } });
  expect(MeResponseSchema.parse(await both.json()).user).toMatchObject({ name: 'Ada', theme: 'light' });
  const again = MeResponseSchema.parse(await (await t.call('GET', '/api/me', { headers })).json());
  expect(again.user).toMatchObject({ name: 'Ada', theme: 'light' });
});

test('an empty, too long or malformed name is 400 and the profile keeps its name', async () => {
  const t = setupApi();
  const { headers } = await t.signIn();
  for (const name of ['', '   ', 'x'.repeat(101), 'a\u0000b', 'a\ud800', 5, null]) {
    const res = await t.call('PATCH', '/api/me', { headers, body: { name } });
    expect(res.status).toBe(400);
  }
  const me = MeResponseSchema.parse(await (await t.call('GET', '/api/me', { headers })).json());
  expect(me.user.name).toBe('Test User');
  expect((await t.call('PATCH', '/api/me', { headers, body: { name: 'x'.repeat(100) } })).status).toBe(200);
});

test('GET /api/usage lists the tasks of the user with credits and tokens; deleted tasks form one row', async () => {
  const t = setupApi({ MAX_ACTIVE_TASKS_PER_USER: '10' });
  const { user, headers } = await t.signIn();
  const other = await t.signIn();
  const task = await t.c.intake.create({ userId: user.id, prompt: 'Find suppliers' });
  const gone = await t.c.intake.create({ userId: user.id, prompt: 'Gone' });
  const charge = (taskId: string | null, millicredits: number, userId = user.id) =>
    t.c.ledger.record({ userId, taskId, model: 'q', tokensIn: 100, tokensOut: 20, millicredits });
  await charge(gone.id, 500);
  t.c.clock.advance(1000);
  await charge(task.id, 1500);
  await charge(null, 7, other.user.id);
  await t.c.tasks.delete(gone.id);

  const res = await t.call('GET', '/api/usage', { headers });
  expect(res.status).toBe(200);
  expect(UsageResponseSchema.parse(await res.json()).usage).toEqual([
    {
      taskId: task.id,
      prompt: 'Find suppliers',
      millicredits: 1500,
      credits: '1.5',
      tokens: 120,
      lastActivityAt: t.c.clock.now().toISOString(),
    },
    {
      taskId: null,
      prompt: null,
      millicredits: 500,
      credits: '0.5',
      tokens: 120,
      lastActivityAt: new Date(t.c.clock.now().getTime() - 1000).toISOString(),
    },
  ]);
  expect((await t.call('GET', '/api/usage')).status).toBe(401);
});
