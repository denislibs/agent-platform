import { expect, test } from 'bun:test';
import { asValue } from 'awilix';
import {
  createTestContainer,
  FakeSearchProvider,
  InMemorySandboxProvider,
  InMemoryTaskRepository,
  InMemoryUnitOfWork,
  ScriptedLlm,
} from '@agent/testing';

test('resolves every port with in-memory doubles sharing one state', async () => {
  const c = createTestContainer();
  const { tasks, steps, memory, clock } = c.cradle;
  expect(tasks).toBeInstanceOf(InMemoryTaskRepository);
  expect(c.cradle.uow).toBeInstanceOf(InMemoryUnitOfWork);
  const userId = memory.seedUser({ millicredits: 10 });
  const task = await tasks.create({ userId, prompt: 'x' });
  await steps.append({
    taskId: task.id,
    agent: 'user',
    payload: { type: 'message', role: 'user', text: 'hi' },
  });
  expect((await c.cradle.tasks.get(task.id))?.lastSeq).toBe(1);
  expect(task.id).toBe('00000000-0000-4000-8000-000000000002'); // детерминированные id: 1 — пользователь, 2 — задача
  expect(task.createdAt.toISOString()).toBe(clock.now().toISOString());
});

test('overrides replace a registration', async () => {
  const llm = new ScriptedLlm([{ content: 'hi' }]);
  const c = createTestContainer({ llm: asValue(llm) });
  expect(c.cradle.llm).toBe(llm);
  expect((await c.cradle.llm.chat({ role: 'executor', messages: [] })).content).toBe('hi');
});

test('each container is isolated', () => {
  const a = createTestContainer();
  const b = createTestContainer();
  a.cradle.memory.seedUser();
  expect(b.cradle.memory.users.size).toBe(0);
});

test('registers in-memory sandboxes and fake search', async () => {
  const c = createTestContainer();
  expect(c.cradle.sandboxes).toBeInstanceOf(InMemorySandboxProvider);
  expect(c.cradle.search).toBeInstanceOf(FakeSearchProvider);
  const s = await c.cradle.sandboxes.create('task-1');
  expect(s.id).toBe('agent-sbx-task-1');
});
