import { expect, test } from 'bun:test';
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
