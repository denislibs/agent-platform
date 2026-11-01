import { expect, test } from 'bun:test';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { ApiErrorSchema } from '@agent/shared';
import { setupApi } from './helpers';

test('health answers without a session', async () => {
  const res = await setupApi().call('GET', '/api/health');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});

test('a protected route without a session is 401 with a typed error body', async () => {
  const res = await setupApi().call('GET', '/api/me');
  expect(res.status).toBe(401);
  expect(ApiErrorSchema.parse(await res.json()).error.code).toBe('unauthorized');
});

test('/api/auth/* goes to the auth handler without a session', async () => {
  const res = await setupApi().call('POST', '/api/auth/sign-in/magic-link', { body: { email: 'a@b.c' } });
  expect(res.status).toBe(200);
  expect(await res.text()).toBe('fake auth: /api/auth/sign-in/magic-link');
});

test('an unknown route is 404 with a typed error body', async () => {
  const t = setupApi();
  const { headers } = await t.signIn();
  const res = await t.call('GET', '/api/nope', { headers });
  expect(res.status).toBe(404);
  expect(ApiErrorSchema.parse(await res.json()).error.code).toBe('not_found');
});

test('an unexpected error is 500 internal: logged with its message, which never reaches the client', async () => {
  const t = setupApi();
  const { headers } = await t.signIn();
  t.c.ledger.balance = async () => {
    throw new Error('connect ECONNREFUSED 10.0.0.5:5432');
  };
  const res = await t.call('GET', '/api/me', { headers });
  expect(res.status).toBe(500);
  const body = ApiErrorSchema.parse(await res.json());
  expect(body.error).toEqual({ code: 'internal', message: 'internal error' });
  expect(t.c.logger.entries).toMatchObject([
    { level: 'error', fields: { method: 'GET', path: '/api/me', error: 'connect ECONNREFUSED 10.0.0.5:5432' } },
  ]);
});

test('a Hono HTTPException keeps its meaning: bodyLimit is 413 payload_too_large, a thrown 401 is unauthorized', async () => {
  const t = setupApi();
  const { headers } = await t.signIn();
  t.app.post('/api/limited', bodyLimit({ maxSize: 4 }), c => c.text('ok'));
  t.app.get('/api/teapot', () => {
    throw new HTTPException(401, { message: 'secret detail' });
  });

  const big = await t.app.request('/api/limited', { method: 'POST', headers, body: 'x'.repeat(100) });
  expect(big.status).toBe(413);
  expect(ApiErrorSchema.parse(await big.json()).error.code).toBe('payload_too_large');

  const denied = await t.call('GET', '/api/teapot', { headers });
  expect(denied.status).toBe(401);
  const text = await denied.text();
  expect(ApiErrorSchema.parse(JSON.parse(text)).error.code).toBe('unauthorized');
  expect(text).not.toContain('secret detail');
  expect(t.c.logger.entries).toEqual([]);
});

test('an HTTPException 5xx is internal: logged, not shown', async () => {
  const t = setupApi();
  const { headers } = await t.signIn();
  t.app.get('/api/boom', () => {
    throw new HTTPException(503, { message: 'redis down at 10.0.0.9' });
  });
  const res = await t.call('GET', '/api/boom', { headers });
  expect(res.status).toBe(500);
  expect(await res.text()).not.toContain('10.0.0.9');
  expect(t.c.logger.entries).toMatchObject([{ level: 'error', fields: { error: 'redis down at 10.0.0.9' } }]);
});

test('an unexpected error is logged with its stack', async () => {
  const t = setupApi();
  const { headers } = await t.signIn();
  t.c.ledger.balance = async () => {
    throw new Error('boom');
  };
  await t.call('GET', '/api/me', { headers });
  const stack = (t.c.logger.entries[0]?.fields as { stack?: unknown } | undefined)?.stack;
  expect(typeof stack).toBe('string');
  expect(stack).toContain('boom');
});

test('only /api/health and /api/auth/* are public: lookalike and unnormalised paths need a session', async () => {
  const t = setupApi();
  for (const path of ['/api/authx', '/api/auth', '/api/health/x', '/api/nope']) {
    const res = await t.call('GET', path);
    expect(res.status).toBe(401);
    expect(ApiErrorSchema.parse(await res.json()).error.code).toBe('unauthorized');
  }
  // URL нормализуется до маршрутизации: /api/auth/../me — это /api/me.
  const dotted = await t.app.request(new Request('http://x/api/auth/../me'));
  expect(dotted.status).toBe(401);
  expect((await t.call('POST', '/api/health')).status).toBe(401);
});

test('a route registered after createApp is guarded too', async () => {
  const t = setupApi();
  t.app.get('/api/later', c => c.json({ id: c.get('user').id }));
  expect((await t.call('GET', '/api/later')).status).toBe(401);
  const { user, headers } = await t.signIn();
  expect(await (await t.call('GET', '/api/later', { headers })).json()).toEqual({ id: user.id });
});
