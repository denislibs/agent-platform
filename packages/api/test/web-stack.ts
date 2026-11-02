import { asValue } from 'awilix';
import { Queue } from 'bullmq';
import { inArray, like } from 'drizzle-orm';
import { buildContainer } from '@agent/composition';
import { files, runMigrations, user, verification } from '@agent/db';
import { AGENT_QUEUE } from '@agent/queue';
import { loadConfig } from '@agent/shared';
import { allowBrowserUploads } from '@agent/storage';
import { CapturingMailer, InMemorySandboxProvider, ScriptedLlm, toolCall, type ScriptedTurn } from '@agent/testing';
import { startWorker } from '@agent/worker';
import { createApp, registerAuth } from '../src';

/**
 * Бэкенд для сквозного теста веб-приложения (apps/web/e2e, Playwright): API и воркер в одном процессе на базе *_test,
 * ScriptedLlm и in-memory песочница — как сквозной тест плана 4b. Браузер ходит через Vite (E2E_WEB_ORIGIN, он же
 * BETTER_AUTH_URL), Vite проксирует /api сюда. Служебные маршруты /__e2e/* — только для теста: ссылка из письма
 * и начисление кредитов. Запуск: playwright.config.ts веб-приложения (webServer).
 */
const EMAIL_DOMAIN = 'web-e2e.test.dev';
const port = Number(process.env.E2E_API_PORT ?? 5197);
const webOrigin = process.env.E2E_WEB_ORIGIN ?? 'http://localhost:5199';

function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set (see .env.test)');
  if (!new URL(url).pathname.endsWith('_test')) throw new Error(`refusing to use a non-test database: ${url}`);
  return url;
}

const calls = (...list: Array<[string, unknown]>): ScriptedTurn => ({
  toolCalls: list.map(([name, args]) => toolCall(name, args)),
  usage: { inputTokens: 100, outputTokens: 10 },
});

/*
 * Свой префикс BullMQ: стенд не видит чужих job и не мешает воркеру разработки. Первый обход sweeper — через час:
 * он не подберёт зависшие задачи других наборов из той же базы *_test и не потратит на них ходы ScriptedLlm.
 */
const config = loadConfig({
  ...process.env,
  DATABASE_URL: testDatabaseUrl(),
  BETTER_AUTH_URL: webOrigin,
  QUEUE_PREFIX: `web-e2e-${crypto.randomUUID()}`,
  SWEEP_EVERY_MS: '3600000',
  SANDBOX_NAMESPACE: 'test',
});
// Сценарий агента: план, вопрос пользователю, файл, отчёт, приёмка, ответ с файлом.
const llm = new ScriptedLlm([
  calls(['create_plan', { subtasks: [{ goal: 'Write the greeting', done_criteria: 'hello.md exists' }] }]),
  calls(['ask_user', { question: 'Which greeting?' }]),
  calls(['file_write', { path: 'outputs/hello.md', content: '# Hello' }]),
  calls(['report', { summary: 'written', files: ['outputs/hello.md'] }]),
  calls(['accept', {}]),
  calls(['finish', { answer: 'Here is **your file**.', files: ['outputs/hello.md'] }]),
]);
const mailer = new CapturingMailer();
const container = registerAuth(
  buildContainer(config, {
    llm: asValue(llm),
    sandboxes: asValue(new InMemorySandboxProvider()),
    mailer: asValue(mailer),
  }),
);
const c = container.cradle;

await runMigrations(config.databaseUrl);
await allowBrowserUploads(config.s3, [webOrigin]);
const worker = await startWorker(c);
const app = createApp(c);

/** Служебные маршруты теста. */
async function control(url: URL): Promise<Response> {
  const email = url.searchParams.get('email') ?? '';
  if (!email.endsWith(`@${EMAIL_DOMAIN}`)) return new Response('test emails only', { status: 400 });
  if (url.pathname === '/__e2e/link') {
    const link = mailer.lastLink(email);
    return link ? new Response(link) : new Response('no link yet', { status: 404 });
  }
  if (url.pathname === '/__e2e/grant') {
    await c.ledger.grant(email, 1_000_000);
    return new Response('ok');
  }
  return new Response('unknown', { status: 404 });
}

const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  idleTimeout: 30,
  fetch: req => {
    const url = new URL(req.url);
    return url.pathname.startsWith('/__e2e/') ? control(url) : app.fetch(req);
  },
});
console.log(`web e2e backend on http://127.0.0.1:${server.port} for ${webOrigin}`);

/**
 * Уборка всего, что оставили пользователи теста (и прерванные прошлые прогоны): объекты S3 — по строкам files
 * пользователя (в том числе загрузки, так и не привязанные к задаче), затем сами пользователи — задачи, шаги, файлы,
 * сессии и аккаунты уходят каскадом; verification ссылается на адрес только внутри value; очередь — целиком.
 */
async function cleanUp(): Promise<void> {
  const { db } = c.database;
  const ids = (
    await db
      .select({ id: user.id })
      .from(user)
      .where(like(user.email, `%@${EMAIL_DOMAIN}`))
  ).map(u => u.id);
  if (ids.length > 0) {
    const objects = await db.select({ key: files.storageKey }).from(files).where(inArray(files.userId, ids));
    for (const { key } of objects) await c.fileStore.delete(key);
    await db.delete(user).where(inArray(user.id, ids));
  }
  await db.delete(verification).where(like(verification.value, `%@${EMAIL_DOMAIN}%`));
  const queue = new Queue(AGENT_QUEUE, { connection: c.redis, prefix: config.worker.queuePrefix });
  try {
    await queue.obliterate({ force: true });
  } finally {
    await queue.close();
  }
}

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  let code = 0;
  try {
    await server.stop(true);
    await worker.close();
    await cleanUp();
    await container.dispose();
    console.log('web e2e backend stopped, test data removed');
  } catch (err) {
    console.error('web e2e backend: clean-up failed', err);
    code = 1;
  } finally {
    process.exit(code);
  }
}
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
