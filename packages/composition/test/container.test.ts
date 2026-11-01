import { afterEach, beforeAll, expect, test } from 'bun:test';
import { asValue } from 'awilix';
import { CryptoIds, LimitExceededError, SystemClock } from '@agent/core';
import { ExecutorStage, PlannerStage, ResultComposer } from '@agent/agent';
import { buildContainer, type AppContainer } from '@agent/composition';
import {
  DrizzleCreditLedger,
  DrizzleFileRepository,
  DrizzleStepLog,
  DrizzleSubtaskRepository,
  DrizzleTaskRepository,
  DrizzleUnitOfWork,
  runMigrations,
  user,
} from '@agent/db';
import { DockerSandboxProvider } from '@agent/sandbox';
import { BraveSearchProvider, UnavailableSearchProvider } from '@agent/search';
import { S3FileStore } from '@agent/storage';
import { loadConfig } from '@agent/shared';
import { ScriptedLlm } from '@agent/testing';

const config = loadConfig();
let container: AppContainer | undefined;

beforeAll(async () => {
  await runMigrations(config.databaseUrl);
});
afterEach(async () => {
  await container?.dispose();
  container = undefined;
});

test('registers a real adapter for every port', () => {
  container = buildContainer(config);
  const c = container.cradle;
  expect(c.tasks).toBeInstanceOf(DrizzleTaskRepository);
  expect(c.steps).toBeInstanceOf(DrizzleStepLog);
  expect(c.subtasks).toBeInstanceOf(DrizzleSubtaskRepository);
  expect(c.ledger).toBeInstanceOf(DrizzleCreditLedger);
  expect(c.files).toBeInstanceOf(DrizzleFileRepository);
  expect(c.uow).toBeInstanceOf(DrizzleUnitOfWork);
  expect(c.fileStore).toBeInstanceOf(S3FileStore);
  expect(c.clock).toBeInstanceOf(SystemClock);
  expect(c.ids).toBeInstanceOf(CryptoIds);
  expect(typeof c.llm.chat).toBe('function');
  expect(c.config).toBe(config);
});

test('agent stages resolve against the real adapters', () => {
  container = buildContainer(config);
  const c = container.cradle;
  expect(c.executorStage).toBeInstanceOf(ExecutorStage);
  expect(c.plannerStage).toBeInstanceOf(PlannerStage);
  expect(c.composer).toBeInstanceOf(ResultComposer);
});

test('registers the docker sandbox provider and, without a key, unavailable search', () => {
  container = buildContainer(config);
  expect(container.cradle.sandboxes).toBeInstanceOf(DockerSandboxProvider);
  expect(container.cradle.search).toBeInstanceOf(UnavailableSearchProvider);
});

test('uses Brave search when BRAVE_API_KEY is configured', () => {
  container = buildContainer({ ...config, search: { ...config.search, braveApiKey: 'k' } });
  expect(container.cradle.search).toBeInstanceOf(BraveSearchProvider);
});

test('wired adapters work together against real infrastructure', async () => {
  container = buildContainer(config);
  const { database, tasks, steps, ledger, fileStore } = container.cradle;
  const [u] = await database.db
    .insert(user)
    .values({
      id: crypto.randomUUID(),
      name: 'C',
      email: `${crypto.randomUUID()}@test.dev`,
      millicredits: 10,
    })
    .returning();
  const task = await tasks.create({ userId: u!.id, prompt: 'wired' });
  await steps.append({
    taskId: task.id,
    agent: 'user',
    payload: { type: 'message', role: 'user', text: 'hi' },
  });
  expect(
    await ledger.record({
      userId: u!.id,
      taskId: task.id,
      model: 'qwen',
      tokensIn: 1,
      tokensOut: 1,
      millicredits: 2,
    }),
  ).toEqual({ balance: 8 });
  const key = `tasks/${task.id}/outputs/hello.txt`;
  await fileStore.put(key, 'hi', 'text/plain');
  expect(await fileStore.getText(key)).toBe('hi');
  await fileStore.delete(key);
});

test('overrides replace adapters (e.g. a scripted model)', async () => {
  const llm = new ScriptedLlm([{ content: 'scripted' }]);
  container = buildContainer(config, { llm: asValue(llm) });
  expect((await container.cradle.llm.chat({ role: 'planner', messages: [] })).content).toBe('scripted');
});

test('singletons are shared with child scopes', () => {
  container = buildContainer(config);
  const scope = container.createScope();
  expect(scope.cradle.tasks).toBe(container.cradle.tasks);
});

test('dispose closes the database pool', async () => {
  const c = buildContainer(config);
  const { database } = c.cradle;
  await database.db.select().from(user).limit(1);
  await c.dispose();
  // Drizzle query builders are thenables, not Promises — wrap so `.rejects` can attach.
  await expect(Promise.resolve(database.db.select().from(user).limit(1))).rejects.toThrow();
});

test('task intake enforces the active task limit against Postgres under concurrency', async () => {
  container = buildContainer({ ...config, limits: { ...config.limits, maxActiveTasksPerUser: 2 } });
  const { database, intake, tasks } = container.cradle;
  const [u] = await database.db
    .insert(user)
    .values({ id: crypto.randomUUID(), name: 'I', email: `${crypto.randomUUID()}@test.dev`, millicredits: 1000 })
    .returning();
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, (_, i) => intake.create({ userId: u!.id, prompt: `t${i}` })),
  );
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(2);
  for (const r of results) if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(LimitExceededError);
  expect(await tasks.countActive(u!.id)).toBe(2);
});
