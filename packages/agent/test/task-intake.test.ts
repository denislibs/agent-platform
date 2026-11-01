import { describe, expect, test } from 'bun:test';
import { asValue } from 'awilix';
import { LimitExceededError, NotFoundError } from '@agent/core';
import { testConfig } from '@agent/testing';
import { createAgentTestContainer } from './helpers';

const setup = (env: Record<string, string> = {}) =>
  createAgentTestContainer({ config: asValue(testConfig(env)) }).cradle;

async function expectLimit(p: Promise<unknown>, limit: 'active_tasks' | 'credits'): Promise<void> {
  await expect(p).rejects.toBeInstanceOf(LimitExceededError);
  await expect(p).rejects.toHaveProperty('limit', limit);
}

describe('TaskIntake', () => {
  test('creates a queued task whose first step is the user prompt', async () => {
    const { intake, memory, steps } = setup();
    const userId = memory.seedUser({ millicredits: 1000 });
    const task = await intake.create({ userId, prompt: 'Compare three CRMs' });
    expect(task).toMatchObject({ userId, prompt: 'Compare three CRMs', status: 'queued', lastSeq: 1 });
    expect(await steps.list(task.id)).toMatchObject([
      { seq: 1, agent: 'user', payload: { type: 'message', role: 'user', text: 'Compare three CRMs' } },
    ]);
  });

  test("attaches the user's uploaded files to the new task", async () => {
    const { intake, memory, files } = setup();
    const userId = memory.seedUser();
    const f = await files.insert({
      userId,
      kind: 'input',
      path: 'data.csv',
      storageKey: 'k1',
      size: 1,
      mime: 'text/csv',
    });
    const task = await intake.create({ userId, prompt: 'x', fileIds: [f.id] });
    expect((await files.listForTask(task.id)).map(x => x.id)).toEqual([f.id]);
  });

  test('refuses when the user already has the maximum of active tasks, and writes nothing', async () => {
    const { intake, memory, tasks } = setup({ MAX_ACTIVE_TASKS_PER_USER: '1' });
    const userId = memory.seedUser();
    await intake.create({ userId, prompt: 'first' });
    await expectLimit(intake.create({ userId, prompt: 'second' }), 'active_tasks');
    expect(await tasks.listForUser(userId)).toHaveLength(1);
  });

  test('a finished task frees its slot', async () => {
    const { intake, memory, tasks } = setup({ MAX_ACTIVE_TASKS_PER_USER: '1' });
    const userId = memory.seedUser();
    const first = await intake.create({ userId, prompt: 'first' });
    await tasks.transition(first.id, 'cancelled');
    expect((await intake.create({ userId, prompt: 'second' })).prompt).toBe('second');
  });

  test('refuses with a zero or negative balance, and writes nothing', async () => {
    const { intake, memory, tasks } = setup();
    for (const millicredits of [0, -5]) {
      const userId = memory.seedUser({ millicredits });
      await expectLimit(intake.create({ userId, prompt: 'x' }), 'credits');
      expect(await tasks.countActive(userId)).toBe(0);
    }
  });

  // In-memory run'ы сериализованы глобально, так что здесь гонки нет; настоящую гарантию закрепляет тест на Postgres в packages/composition/test/container.test.ts.
  test('concurrent requests cannot exceed the active task limit', async () => {
    const { intake, memory, tasks } = setup({ MAX_ACTIVE_TASKS_PER_USER: '2' });
    const userId = memory.seedUser();
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) => intake.create({ userId, prompt: `t${i}` })),
    );
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(2);
    for (const r of results) if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(LimitExceededError);
    expect(await tasks.countActive(userId)).toBe(2);
  });

  test('unknown user → NotFoundError', async () => {
    const { intake } = setup();
    await expect(intake.create({ userId: 'nobody', prompt: 'x' })).rejects.toBeInstanceOf(NotFoundError);
  });
});
