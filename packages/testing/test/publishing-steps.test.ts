import { describe, expect, test } from 'bun:test';
import { PublishingStepLog, PublishingUnitOfWork } from '@agent/core';
import { createTestContainer } from '@agent/testing';

const note = (text: string) => ({ type: 'message', role: 'assistant', text }) as const;

function setup() {
  const c = createTestContainer().cradle;
  return { c, userId: c.memory.seedUser() };
}

describe('publishing steps and unit of work', () => {
  test('the test container wraps steps and uow', () => {
    const { c } = setup();
    expect(c.steps).toBeInstanceOf(PublishingStepLog);
    expect(c.uow).toBeInstanceOf(PublishingUnitOfWork);
  });

  test('an append outside a transaction is announced with its seq', async () => {
    const { c, userId } = setup();
    const task = await c.tasks.create({ userId, prompt: 'x' });
    await c.steps.append({ taskId: task.id, agent: 'system', payload: note('a') });
    await c.steps.append({ taskId: task.id, agent: 'system', payload: note('b') });
    expect(c.stepEvents.published).toEqual([
      { taskId: task.id, lastSeq: 1 },
      { taskId: task.id, lastSeq: 2 },
    ]);
  });

  test('a transaction announces the last seq of every task it touched, once, after commit', async () => {
    const { c, userId } = setup();
    const a = await c.tasks.create({ userId, prompt: 'a' });
    const b = await c.tasks.create({ userId, prompt: 'b' });
    await c.uow.run(async tx => {
      await tx.steps.append({ taskId: a.id, agent: 'system', payload: note('1') });
      await tx.steps.append({ taskId: a.id, agent: 'system', payload: note('2') });
      await tx.steps.append({ taskId: b.id, agent: 'system', payload: note('3') });
      expect(c.stepEvents.published).toEqual([]);
    });
    expect(c.stepEvents.published).toEqual([
      { taskId: a.id, lastSeq: 2 },
      { taskId: b.id, lastSeq: 1 },
    ]);
  });

  test('a rolled back transaction announces nothing', async () => {
    const { c, userId } = setup();
    const task = await c.tasks.create({ userId, prompt: 'x' });
    const run = c.uow.run(async tx => {
      await tx.steps.append({ taskId: task.id, agent: 'system', payload: note('lost') });
      throw new Error('rollback');
    });
    await expect(run).rejects.toThrow('rollback');
    expect(c.stepEvents.published).toEqual([]);
    expect((await c.tasks.get(task.id))?.lastSeq).toBe(0);
  });

  test('a failed publish is logged and does not fail the committed append', async () => {
    const { c, userId } = setup();
    const task = await c.tasks.create({ userId, prompt: 'x' });
    c.stepEvents.publish = async () => {
      throw new Error('valkey is gone');
    };
    const step = await c.steps.append({ taskId: task.id, agent: 'system', payload: note('a') });
    expect(step.seq).toBe(1);
    expect(c.logger.entries).toMatchObject([
      { level: 'warn', fields: { taskId: task.id, lastSeq: 1, error: 'valkey is gone' } },
    ]);
  });

  test('inside run the other tx repositories and lockUser still work', async () => {
    const { c, userId } = setup();
    const active = await c.uow.run(async tx => {
      await tx.lockUser(userId);
      await tx.tasks.create({ userId, prompt: 'x' });
      return tx.tasks.countActive(userId);
    });
    expect(active).toBe(1);
  });

  test('a container repository inside run is still caught by the in-memory guard', async () => {
    const { c, userId } = setup();
    const task = await c.tasks.create({ userId, prompt: 'x' });
    const run = c.uow.run(() => c.steps.append({ taskId: task.id, agent: 'system', payload: note('a') }));
    await expect(run).rejects.toThrow(/repository from the container used inside UnitOfWork.run/);
  });
});
