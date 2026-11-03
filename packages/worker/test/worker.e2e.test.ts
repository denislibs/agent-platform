import { afterAll, beforeAll, expect, test } from 'bun:test';
import { asValue } from 'awilix';
import { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { buildContainer, type AppContainer } from '@agent/composition';
import { files, runMigrations, user } from '@agent/db';
import { AGENT_QUEUE } from '@agent/queue';
import { loadConfig } from '@agent/shared';
import { ScriptedLlm, toolCall, type ScriptedTurn } from '@agent/testing';
import { startWorker, type RunningWorker } from '../src';

const calls = (...list: Array<[string, unknown]>): ScriptedTurn => ({
  toolCalls: list.map(([name, args]) => toolCall(name, args)),
  usage: { inputTokens: 100, outputTokens: 10 },
});

// Свой префикс ключей BullMQ: тест не видит чужих job и не мешает воркеру разработки.
const config = loadConfig({ ...process.env, QUEUE_PREFIX: `e2e-${crypto.randomUUID()}`, SWEEP_EVERY_MS: '3600000' });
const llm = new ScriptedLlm([
  calls(['create_plan', { subtasks: [{ goal: 'write', done_criteria: 'file written' }] }]),
  calls(['file_write', { path: 'outputs/hello.md', content: '# Hello' }]),
  calls(['report', { summary: 'written', files: ['outputs/hello.md'] }]),
  calls(['accept', {}]),
  calls(['finish', { answer: 'Here is your file', files: ['outputs/hello.md'] }]),
]);
let container: AppContainer;
let worker: RunningWorker;
let taskId: string | undefined;
let userId: string | undefined;

beforeAll(async () => {
  await runMigrations(config.databaseUrl);
  container = buildContainer(config, { llm: asValue(llm) });
  worker = await startWorker(container.cradle);
}, 60_000);

afterAll(async () => {
  await worker?.close();
  if (container) {
    const c = container.cradle;
    // Песочница упавшего теста и ключи BullMQ под его префиксом не должны пережить прогон.
    if (taskId) await (await c.sandboxes.get(`agent-sbx-${taskId}`))?.destroy();
    // Пользователь теста и его данные: сначала объекты S3 по строкам files, затем сам пользователь —
    // задачи, шаги, файлы и проводки уходят каскадом. Чужие данные не трогаются.
    if (userId) {
      const { db } = c.database;
      const objects = await db.select({ key: files.storageKey }).from(files).where(eq(files.userId, userId));
      for (const { key } of objects) await c.fileStore.delete(key);
      await db.delete(user).where(eq(user.id, userId));
    }
    const raw = new Queue(AGENT_QUEUE, { connection: c.redis, prefix: config.worker.queuePrefix });
    await raw.obliterate({ force: true });
    await raw.close();
  }
  await container?.dispose();
}, 60_000);

async function waitFor<T>(read: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 90_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > until) throw new Error(`timed out; last value: ${JSON.stringify(v)}`);
    await Bun.sleep(250);
  }
}

test('a task goes from intake to done through BullMQ, Postgres, Docker and S3', async () => {
  const c = container.cradle;
  const [u] = await c.database.db
    .insert(user)
    .values({ id: crypto.randomUUID(), name: 'E2E', email: `${crypto.randomUUID()}@test.dev`, millicredits: 1_000_000 })
    .returning();
  userId = u!.id;
  const task = await c.intake.create({ userId, prompt: 'Write hello.md' });
  taskId = task.id;

  const done = await waitFor(
    () => c.tasks.get(task.id),
    t => t !== undefined && ['done', 'failed', 'cancelled'].includes(t.status),
  );
  expect(done).toMatchObject({ status: 'done', result: 'Here is your file' });
  expect(llm.remaining).toBe(0);

  const outputs = await c.files.listForTask(task.id, 'output');
  expect(outputs.map(f => f.path)).toEqual(['outputs/hello.md']);
  expect(await c.fileStore.getText(outputs[0]!.storageKey)).toBe('# Hello');
  // Песочница законченной задачи ждёт продолжения беседы остановленной (план 9); удалит её afterAll.
  await waitFor(
    async () => (await c.sandboxes.list()).find(s => s.taskId === task.id),
    s => s?.running === false,
    30_000,
  );
}, 120_000);
