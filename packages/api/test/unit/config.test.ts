import { expect, test } from 'bun:test';
import { ClientConfigSchema } from '@agent/shared';
import { setupApi } from './helpers';

test('GET /api/config needs no session and lists only the configured sign-in providers', async () => {
  const t = setupApi({ GITHUB_CLIENT_ID: 'gh-id', GITHUB_CLIENT_SECRET: 'gh-secret', UPLOAD_MAX_BYTES: '1048576' });
  const res = await t.call('GET', '/api/config');
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(ClientConfigSchema.parse(await res.json())).toEqual({ providers: ['github'], uploadMaxBytes: 1_048_576 });
});

test('without OAuth apps only the magic link is left', async () => {
  const t = setupApi();
  const body = ClientConfigSchema.parse(await (await t.call('GET', '/api/config')).json());
  expect(body.providers).toEqual([]);
});

test('POST /api/config is still guarded: the exception is for GET only', async () => {
  const t = setupApi();
  expect((await t.call('POST', '/api/config', { body: {} })).status).toBe(401);
});
