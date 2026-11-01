import { expect, test } from 'bun:test';
import { LogMailer } from '@agent/core';
import { ApiErrorSchema } from '@agent/shared';
import { CapturingLogger, CapturingMailer } from '@agent/testing';
import { idleTimeoutSec, warnIfMailIsLogged, withJsonErrors } from '../../src';
import { setupApi } from './helpers';

test('the idle timeout is twice the SSE heartbeat, within Bun limits', () => {
  expect(idleTimeoutSec(15_000)).toBe(30);
  expect(idleTimeoutSec(40_000)).toBe(80);
  expect(idleTimeoutSec(1_000)).toBe(30);
  expect(idleTimeoutSec(10_000_000)).toBe(255);
});

test('a non-Error throw that escapes Hono is still a 500 internal JSON envelope, logged', async () => {
  const t = setupApi();
  const { headers } = await t.signIn();
  t.app.get('/api/odd', () => {
    // Hono передаёт в onError только Error; всё остальное улетает из app.fetch.
    throw 'db password=hunter2';
  });
  const logger = new CapturingLogger();
  const fetch = withJsonErrors((req: Request) => t.app.fetch(req), logger);

  const res = await fetch(new Request('http://x/api/odd', { headers }));
  expect(res.status).toBe(500);
  expect(res.headers.get('content-type')).toStartWith('application/json');
  const text = await res.text();
  expect(ApiErrorSchema.parse(JSON.parse(text)).error).toEqual({ code: 'internal', message: 'internal error' });
  expect(text).not.toContain('hunter2');
  expect(logger.entries).toMatchObject([
    { level: 'error', message: 'unhandled API error', fields: { method: 'GET', path: '/api/odd' } },
  ]);
});

test('a synchronous throw from the handler is caught too', async () => {
  const logger = new CapturingLogger();
  const fetch = withJsonErrors(() => {
    throw new Error('boom');
  }, logger);
  const res = await fetch(new Request('http://x/api/me'));
  expect(res.status).toBe(500);
  expect(ApiErrorSchema.parse(await res.json()).error.code).toBe('internal');
  expect(logger.entries).toMatchObject([{ level: 'error', fields: { error: 'boom' } }]);
});

test('normal responses pass through the wrapper unchanged', async () => {
  const t = setupApi();
  const fetch = withJsonErrors((req: Request) => t.app.fetch(req), new CapturingLogger());
  const res = await fetch(new Request('http://x/api/health'));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});

test('the log mailer warning fires unless NODE_ENV is test or development', () => {
  for (const env of ['production', 'staging', undefined]) {
    const logger = new CapturingLogger();
    warnIfMailIsLogged({ mailer: new LogMailer({ logger }), logger }, env);
    expect({ env, entries: logger.entries }).toMatchObject({
      env,
      entries: [{ level: 'warn', message: expect.stringContaining('magic links') }],
    });
  }
});

test('no warning in test or development, or with a real mail provider', () => {
  const logger = new CapturingLogger();
  warnIfMailIsLogged({ mailer: new LogMailer({ logger }), logger }, 'development');
  warnIfMailIsLogged({ mailer: new LogMailer({ logger }), logger }, 'test');
  warnIfMailIsLogged({ mailer: new CapturingMailer(), logger }, 'production');
  expect(logger.entries).toEqual([]);
});
