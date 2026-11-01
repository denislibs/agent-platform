import { expect, test } from 'bun:test';
import { Hono } from 'hono';
import { z } from 'zod';
import { ApiErrorSchema, ListTasksQuerySchema } from '@agent/shared';
import { mapError, parseJson, parseQuery } from '../../src';

const Body = z.object({ name: z.string().min(1) });

/** Мини-приложение с настоящими parseJson/parseQuery и тем же отображением ошибок, что в createApp. */
function harness() {
  const app = new Hono();
  app.onError((err, c) => {
    const { status, body } = mapError(err);
    return c.json(body, status);
  });
  app.post('/json', async c => c.json(await parseJson(c, Body)));
  app.get('/query', c => c.json(parseQuery(c, ListTasksQuerySchema)));
  return app;
}

const post = (headers: Record<string, string>, body: string) =>
  harness().request('/json', { method: 'POST', headers, body });

test('parseJson accepts application/json with or without a charset', async () => {
  for (const type of ['application/json', 'application/json; charset=utf-8', 'Application/JSON;charset=UTF-8']) {
    const res = await post({ 'content-type': type }, '{"name":"a"}');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: 'a' });
  }
});

test('parseJson rejects any other content type as bad_request (CSRF defence in depth)', async () => {
  for (const headers of <Record<string, string>[]>[
    { 'content-type': 'text/plain' },
    { 'content-type': 'application/x-www-form-urlencoded' },
    {},
  ]) {
    const res = await post(headers, '{"name":"a"}');
    expect(res.status).toBe(400);
    expect(ApiErrorSchema.parse(await res.json()).error.code).toBe('bad_request');
  }
});

test('parseJson turns malformed JSON into bad_request', async () => {
  const res = await post({ 'content-type': 'application/json' }, '{"name":');
  expect(res.status).toBe(400);
  expect(ApiErrorSchema.parse(await res.json()).error).toEqual({
    code: 'bad_request',
    message: 'the request body must be JSON',
  });
});

test('parseJson turns a schema failure into bad_request without echoing the input', async () => {
  const res = await post({ 'content-type': 'application/json' }, '{"name":"","password":"hunter2-secret"}');
  expect(res.status).toBe(400);
  const text = await res.text();
  expect(ApiErrorSchema.parse(JSON.parse(text)).error.code).toBe('bad_request');
  expect(text).not.toContain('hunter2-secret');
});

test('parseQuery turns a schema failure into bad_request', async () => {
  const res = await harness().request('/query?limit=999');
  expect(res.status).toBe(400);
  expect(ApiErrorSchema.parse(await res.json()).error.code).toBe('bad_request');
  expect(await (await harness().request('/query?limit=7')).json()).toEqual({ limit: 7 });
});
