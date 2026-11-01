import { afterAll, beforeAll, expect, test } from 'bun:test';
import { asValue } from 'awilix';
import { buildContainer, type AppContainer } from '@agent/composition';
import { runMigrations, user } from '@agent/db';
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

beforeAll(async () => {
  await runMigrations(config.databaseUrl);
  container = buildContainer(config, { llm: asValue(llm) });
  worker = await startWorker(container.cradle);
}, 60_000);

afterAll(async () => {
  await worker?.close();
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
  const task = await c.intake.create({ userId: u!.id, prompt: 'Write hello.md' });

  const done = await waitFor(
    () => c.tasks.get(task.id),
    t => t !== undefined && ['done', 'failed', 'cancelled'].includes(t.status),
  );
  expect(done).toMatchObject({ status: 'done', result: 'Here is your file' });
  expect(llm.remaining).toBe(0);

  const files = await c.files.listForTask(task.id, 'output');
  expect(files.map(f => f.path)).toEqual(['outputs/hello.md']);
  expect(await c.fileStore.getText(files[0]!.storageKey)).toBe('# Hello');
  await waitFor(
    () => c.sandboxes.get(`agent-sbx-${task.id}`),
    s => s === undefined,
    30_000,
  );
}, 120_000);
