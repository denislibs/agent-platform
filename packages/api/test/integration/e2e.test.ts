import { afterAll, beforeAll, expect, test } from 'bun:test';
import { asValue } from 'awilix';
import { Queue } from 'bullmq';
import { eq, like } from 'drizzle-orm';
import { buildContainer } from '@agent/composition';
import { runMigrations, user, verification } from '@agent/db';
import { AGENT_QUEUE } from '@agent/queue';
import {
  loadConfig,
  StepDtoSchema,
  StreamEndSchema,
  TaskEnvelopeSchema,
  TaskResponseSchema,
  type StreamEnd,
} from '@agent/shared';
import { CapturingMailer, InMemorySandboxProvider, ScriptedLlm, toolCall, type ScriptedTurn } from '@agent/testing';
import { startWorker, type RunningWorker } from '@agent/worker';
import { createApp, registerAuth } from '../../src';
import { sseReader } from '../sse';

/** Только база *_test: тест создаёт пользователя, задачу и файлы. */
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
 * Свой префикс BullMQ: тест не видит чужих job и не мешает воркеру разработки. Первый обход sweeper — через час:
 * он не подберёт зависшие задачи других наборов из той же базы *_test и не потратит на них ходы ScriptedLlm.
 */
const config = loadConfig({
  ...process.env,
  DATABASE_URL: testDatabaseUrl(),
  QUEUE_PREFIX: `api-e2e-${crypto.randomUUID()}`,
  SWEEP_EVERY_MS: '3600000',
  SANDBOX_NAMESPACE: 'test',
});
const origin = new URL(config.auth.baseUrl).origin;
const llm = new ScriptedLlm([
  calls(['create_plan', { subtasks: [{ goal: 'write', done_criteria: 'file written' }] }]),
  calls(['ask_user', { question: 'Which greeting?' }]),
  calls(['file_write', { path: 'outputs/hello.md', content: '# Hello' }]),
  calls(['report', { summary: 'written', files: ['outputs/hello.md'] }]),
  calls(['accept', {}]),
  calls(['finish', { answer: 'Here is your file', files: ['outputs/hello.md'] }]),
]);
const mailer = new CapturingMailer();
const container = registerAuth(
  buildContainer(config, {
    llm: asValue(llm),
    sandboxes: asValue(new InMemorySandboxProvider()),
    mailer: asValue(mailer),
  }),
);
let worker: RunningWorker | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let base = '';
let email: string | undefined;
let taskId: string | undefined;

beforeAll(async () => {
  await runMigrations(config.databaseUrl);
  worker = await startWorker(container.cradle);
  server = Bun.serve({ port: 0, fetch: createApp(container.cradle).fetch, idleTimeout: 30 });
  base = `http://localhost:${server.port}`;
}, 60_000);

afterAll(async () => {
  await server?.stop(true);
  await worker?.close();
  const c = container.cradle;
  if (taskId) {
    // Объекты S3 удаляем сами: каскад по пользователю уносит только строки files.
    for (const file of await c.files.listForTask(taskId)) await c.fileStore.delete(file.storageKey);
    await (await c.sandboxes.get(`agent-sbx-${taskId}`))?.destroy();
  }
  if (email) {
    // Задачи, шаги, файлы, сессии и аккаунт уходят каскадом; verification ссылается на адрес только внутри value.
    await c.database.db.delete(user).where(eq(user.email, email));
    await c.database.db.delete(verification).where(like(verification.value, `%${email}%`));
  }
  const raw = new Queue(AGENT_QUEUE, { connection: c.redis, prefix: config.worker.queuePrefix });
  try {
    await raw.obliterate({ force: true });
  } finally {
    await raw.close();
  }
  await container.dispose();
}, 60_000);

/** Настоящий magic link: ссылка из письма указывает на BETTER_AUTH_URL, переходим по ней на тестовый сервер. */
async function signIn(address: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/sign-in/magic-link`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ email: address, callbackURL: '/' }),
  });
  expect(res.status).toBe(200);
  const link = new URL(mailer.lastLink(address)!);
  expect(link.origin).toBe(origin);
  const verify = await fetch(`${base}${link.pathname}${link.search}`, { redirect: 'manual' });
  expect(verify.status).toBe(302);
  return verify.headers
    .getSetCookie()
    .map(c => c.split(';')[0])
    .join('; ');
}

/** Сколько ждать end от создания задачи; штатно сценарий занимает около секунды. */
const STREAM_DEADLINE_MS = 60_000;

/**
 * Следующее событие не позже `deadline`. Тайм-аут sseReader считается на каждое чтение, и пинги сердцебиения
 * его продлевают: без общего срока зависшая задача упёрлась бы в тайм-аут теста без внятной причины.
 */
async function nextBefore(sse: ReturnType<typeof sseReader>, deadline: number, seen: number[]) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`no end event within ${STREAM_DEADLINE_MS} ms; steps received: ${seen.join(',')}`)),
      Math.max(0, deadline - Date.now()),
    );
  });
  try {
    return await Promise.race([sse.next({ timeoutMs: STREAM_DEADLINE_MS }), late]);
  } finally {
    clearTimeout(timer);
  }
}

test('a task created through the API runs on the worker; the stream carries the question, the answer and the end', async () => {
  email = `${crypto.randomUUID()}@api-e2e.test.dev`;
  const cookie = await signIn(email);
  expect(cookie).toContain('better-auth.session_token=');
  await container.cradle.ledger.grant(email, 1_000_000);
  // Изменяющие запросы — как из браузера на странице приложения: с Origin, который ждёт csrf.
  const json = { cookie, origin, 'content-type': 'application/json' };

  const created = await fetch(`${base}/api/tasks`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ prompt: 'Write hello.md' }),
  });
  expect(created.status).toBe(201);
  const { task } = TaskEnvelopeSchema.parse(await created.json());
  taskId = task.id;

  const events = await fetch(`${base}/api/tasks/${task.id}/events`, { headers: { cookie } });
  expect(events.status).toBe(200);
  expect(events.headers.get('content-type')).toStartWith('text/event-stream');
  const sse = sseReader(events);
  const seqs: number[] = [];
  let question: string | undefined;
  let answered = false;
  let replyEchoed = false;
  let end: StreamEnd | undefined;
  const deadline = Date.now() + STREAM_DEADLINE_MS;
  try {
    while (!end) {
      const event = await nextBefore(sse, deadline, seqs);
      if (!event) throw new Error('the stream closed before the end event');
      if (event.event === 'end') {
        end = StreamEndSchema.parse(JSON.parse(event.data));
        break;
      }
      expect(event.event).toBe('step');
      const step = StepDtoSchema.parse(JSON.parse(event.data));
      expect(event.id).toBe(String(step.seq));
      seqs.push(step.seq);
      const { payload } = step;
      if (payload.type === 'tool_result' && payload.control?.kind === 'ask_user')
        question = String(payload.control.question);
      if (payload.type === 'message' && payload.role === 'user' && payload.text === 'A markdown heading')
        replyEchoed = true;
      if (!answered && payload.type === 'status' && payload.to === 'waiting_user') {
        answered = true;
        expect(question).toBe('Which greeting?');
        const reply = await fetch(`${base}/api/tasks/${task.id}/messages`, {
          method: 'POST',
          headers: json,
          body: JSON.stringify({ text: 'A markdown heading' }),
        });
        expect(reply.status).toBe(202);
      }
    }
  } finally {
    await sse.cancel();
  }
  expect(end).toEqual({ status: 'done' });
  expect(answered).toBe(true);
  // Ответ пользователя записан шагом и пришёл в тот же поток.
  expect(replyEchoed).toBe(true);
  // Каждый шаг пришёл ровно один раз и по порядку.
  expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
  expect(llm.remaining).toBe(0);

  const detail = TaskResponseSchema.parse(
    await (await fetch(`${base}/api/tasks/${task.id}`, { headers: { cookie } })).json(),
  );
  expect(detail.task).toMatchObject({ status: 'done', result: 'Here is your file' });
  const output = detail.files.find(f => f.kind === 'output');
  expect(output?.path).toBe('outputs/hello.md');

  const redirect = await fetch(`${base}${output!.url}`, { headers: { cookie }, redirect: 'manual' });
  expect(redirect.status).toBe(302);
  const download = await fetch(redirect.headers.get('location')!);
  expect(download.status).toBe(200);
  expect(download.headers.get('content-disposition')).toStartWith('attachment;');
  expect(await download.text()).toBe('# Hello');
}, 120_000);
