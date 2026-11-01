import { afterEach, expect, test } from 'bun:test';
import { CapturingLogger } from '@agent/testing';
import { createApp, OpenStreams, stopServer, withJsonErrors } from '../../src';
import { sseReader } from '../sse';
import { setupApi } from './helpers';

// Настоящий Bun.serve на свободном порту: обрыв соединения и остановка сервера видны только так, не через app.request.

type Server = ReturnType<typeof Bun.serve>;
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
});

async function until(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await Bun.sleep(5);
  }
}

async function serveApi() {
  const t = setupApi();
  const streams = new OpenStreams();
  const app = createApp(t.c, { streams });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: withJsonErrors(app.fetch, t.c.logger) });
  servers.push(server);
  const { user, headers } = await t.signIn();
  const task = await t.c.intake.create({ userId: user.id, prompt: 'p' });
  const url = `http://127.0.0.1:${server.port}/api/tasks/${task.id}/events`;
  return { t, app, streams, server, headers, task, url };
}

test('a client that drops the connection is unsubscribed and its stream is released', async () => {
  const { t, streams, headers, task, url } = await serveApi();
  const abort = new AbortController();
  const sse = sseReader(await fetch(url, { headers, signal: abort.signal }));
  expect((await sse.next())?.id).toBe('1');
  expect(t.c.stepEvents.subscribers(task.id)).toBe(1);
  expect(streams.size).toBe(1);

  abort.abort();
  await until(() => t.c.stepEvents.subscribers(task.id) === 0 && streams.size === 0);
});

test('shutdown closes open event streams, so the server stops at once', async () => {
  const { t, streams, server, headers, task, url } = await serveApi();
  const sse = sseReader(await fetch(url, { headers }));
  expect((await sse.next())?.id).toBe('1');

  const logger = new CapturingLogger();
  const started = performance.now();
  await stopServer(server, streams, { graceMs: 5000, logger });
  expect(performance.now() - started).toBeLessThan(1000);
  // Поток закрыт без end: EventSource переподключится к другому экземпляру с Last-Event-ID.
  expect(await sse.next()).toBeUndefined();
  expect(t.c.stepEvents.subscribers(task.id)).toBe(0);
  expect(streams.size).toBe(0);
  expect(logger.entries).toMatchObject([{ level: 'info', fields: { streams: 1 } }]);
});

test('connections still open after the grace period are closed by force', async () => {
  const { app, streams, server, headers } = await serveApi();
  // Ответ, который никогда не заканчивается и не входит в OpenStreams.
  app.get(
    '/api/forever',
    () => new Response(new ReadableStream({ start: c => c.enqueue(new TextEncoder().encode('x')) })),
  );
  const res = await fetch(`http://127.0.0.1:${server.port}/api/forever`, { headers });
  const reader = res.body!.getReader();
  await reader.read();

  const logger = new CapturingLogger();
  const started = performance.now();
  await stopServer(server, streams, { graceMs: 50, logger });
  expect(performance.now() - started).toBeLessThan(1000);
  expect(logger.entries).toMatchObject([{ level: 'warn', message: expect.stringContaining('force') }]);
  await reader.read().catch(() => undefined);
});
