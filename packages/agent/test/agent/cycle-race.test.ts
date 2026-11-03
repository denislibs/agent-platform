import { describe, expect, test } from 'bun:test';
import { LlmError } from '@agent/core';
import { jobKey } from '../../src';
import { calls, planned, seedTask, setupAgent } from './fixtures';

type C = ReturnType<typeof setupAgent>;

/** Пользователь остановил задачу и сразу написал новое сообщение: как cancelTask и POST /messages. */
async function cancelAndReopen(c: C, taskId: string) {
  const task = (await c.tasks.get(taskId))!;
  await c.uow.run(async tx => {
    await tx.tasks.transition(taskId, 'cancelled', { finishedAt: c.clock.now() });
    await tx.steps.append({ taskId, agent: 'user', payload: { type: 'status', from: task.status, to: 'cancelled' } });
  });
  await c.intake.reopen({ taskId, userId: task.userId, text: 'Changed my mind' });
  return (await c.tasks.get(taskId))!;
}

/** Пока модель отвечает на следующий вызов, задачу останавливают и открывают заново. */
function reopenDuringNextCall(c: C, taskId: string) {
  const chat = c.llm.chat.bind(c.llm);
  c.llm.chat = async req => {
    c.llm.chat = chat;
    const result = await chat(req);
    await cancelAndReopen(c, taskId);
    return result;
  };
}

/** Шаги после открытия заново: только статус и сообщение пользователя, старый job не дописал ничего. */
async function expectNewCycleUntouched(c: C, taskId: string) {
  const steps = await c.steps.list(taskId);
  const at = steps.findLastIndex(s => s.payload.type === 'status' && s.payload.to === 'planning');
  expect(steps.slice(at)).toMatchObject([
    { payload: { type: 'status', from: 'cancelled', to: 'planning' } },
    { agent: 'user', payload: { type: 'message', text: 'Changed my mind' } },
  ]);
  const task = (await c.tasks.get(taskId))!;
  expect(task).toMatchObject({ status: 'planning', cycle: 2, currentKind: 'plan', result: null });
  // Единственный job — тот, что поставило открытие заново: второй цепочки нет.
  expect(c.queue.jobs).toEqual([{ taskId, kind: 'plan', key: jobKey(taskId, 'plan', task.lastSeq) }]);
}

/** Задача на проверке подзадачи или перед финальным ответом: job следующей стадии не поставлен. */
async function reviewing(c: C) {
  const task = await planned(c);
  const [sub] = await c.subtasks.list(task.id);
  await c.subtasks.transition(sub!.id, 'running');
  await c.subtasks.transition(sub!.id, 'reviewing', { report: { summary: 'done', files: [], issues: [] } });
  await c.tasks.update(task.id, { currentKind: 'review' });
  return task;
}

async function finalizing(c: C) {
  const task = await reviewing(c);
  const [sub] = await c.subtasks.list(task.id);
  await c.subtasks.transition(sub!.id, 'accepted');
  await c.guard.toFinalizing(task, 'running');
  return task;
}

describe('a job still working when its task is reopened', () => {
  test('plan: the late create_plan is charged but not recorded or applied', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    c.queue.next();
    c.llm.push(calls(['create_plan', { subtasks: [{ goal: 'old plan', done_criteria: 'x' }] }]));
    reopenDuringNextCall(c, task.id);

    expect(await c.runner.run({ taskId: task.id, kind: 'plan' })).toEqual({ next: 'stop' });

    await expectNewCycleUntouched(c, task.id);
    expect(await c.subtasks.list(task.id)).toEqual([]);
    expect(await c.ledger.spentOnTask(task.id)).toBeGreaterThan(0);
    expect((await c.tasks.get(task.id))?.tokensUsed).toBe(110);
  });

  test('plan: the job queued by the reopen then plans the new cycle', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    c.queue.next();
    c.llm.push(calls(['create_plan', { subtasks: [{ goal: 'old plan', done_criteria: 'x' }] }]));
    reopenDuringNextCall(c, task.id);
    await c.runner.run({ taskId: task.id, kind: 'plan' });

    c.llm.push(calls(['create_plan', { subtasks: [{ goal: 'new plan', done_criteria: 'x' }] }]));
    expect(await c.runner.run(c.queue.next()!)).toEqual({ next: 'execute' });
    expect((await c.subtasks.list(task.id)).map(s => [s.goal, s.cycle])).toEqual([['new plan', 2]]);
    expect((await c.tasks.get(task.id))?.status).toBe('running');
  });

  test('execute: the late report does not move the subtask', async () => {
    const c = setupAgent();
    const task = await planned(c);
    c.llm.push(calls(['report', { summary: 'late' }]));
    reopenDuringNextCall(c, task.id);

    expect(await c.runner.run({ taskId: task.id, kind: 'execute' })).toEqual({ next: 'stop' });

    await expectNewCycleUntouched(c, task.id);
    expect(await c.subtasks.list(task.id)).toMatchObject([{ status: 'failed', report: null }]);
  });

  test('execute: a command that outlives the reopen leaves no result and the next call of the turn never runs', async () => {
    const c = setupAgent();
    const task = await planned(c);
    const commands: string[] = [];
    c.sandboxes.handlers = {
      exec: async cmd => {
        commands.push(cmd);
        await cancelAndReopen(c, task.id);
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
      },
    };
    c.llm.push(calls(['shell', { cmd: 'first' }], ['shell', { cmd: 'second' }]));

    expect(await c.runner.run({ taskId: task.id, kind: 'execute' })).toEqual({ next: 'stop' });

    expect(commands).toEqual(['first']);
    await expectNewCycleUntouched(c, task.id);
  });

  test('review: the late accept is not applied', async () => {
    const c = setupAgent();
    const task = await reviewing(c);
    c.llm.push(calls(['accept', {}]));
    reopenDuringNextCall(c, task.id);

    expect(await c.runner.run({ taskId: task.id, kind: 'review' })).toEqual({ next: 'stop' });

    await expectNewCycleUntouched(c, task.id);
    expect(await c.subtasks.list(task.id)).toMatchObject([{ status: 'failed' }]);
  });

  test('finalize: the late answer writes no result and does not finish the new cycle', async () => {
    const c = setupAgent();
    const task = await finalizing(c);
    c.llm.push(calls(['finish', { answer: 'late answer', files: [] }]));
    reopenDuringNextCall(c, task.id);

    expect(await c.runner.run({ taskId: task.id, kind: 'finalize' })).toEqual({ next: 'stop' });

    await expectNewCycleUntouched(c, task.id);
  });

  test('finalize: a reopen during the upload does not mark the new cycle done', async () => {
    const c = setupAgent();
    const task = await finalizing(c);
    const sandbox = await c.sandboxes.create(task.id);
    await sandbox.writeFile('outputs/a.md', 'a');
    c.llm.push(calls(['finish', { answer: 'answer', files: ['outputs/a.md'] }]));
    const put = c.fileStore.put.bind(c.fileStore);
    c.fileStore.put = async (key, data, type) => {
      await put(key, data, type);
      c.fileStore.put = put;
      await cancelAndReopen(c, task.id);
    };

    expect(await c.runner.run({ taskId: task.id, kind: 'finalize' })).toEqual({ next: 'stop' });

    await expectNewCycleUntouched(c, task.id);
  });

  test('a model failure of the old job neither fails nor finalizes the new cycle', async () => {
    for (const retryable of [true, false]) {
      const c = setupAgent();
      const task = await planned(c);
      c.llm.chat = async () => {
        await cancelAndReopen(c, task.id);
        throw new LlmError('unavailable', 'the model is down', retryable);
      };
      expect(await c.runner.run({ taskId: task.id, kind: 'execute' })).toEqual({ next: 'stop' });
      await expectNewCycleUntouched(c, task.id);
    }
  });

  test('the time of the old job does not count against the new cycle', async () => {
    const c = setupAgent();
    const task = await planned(c);
    c.llm.push(calls(['report', { summary: 'late' }]));
    const chat = c.llm.chat.bind(c.llm);
    c.llm.chat = async req => {
      c.clock.advance(5000);
      const result = await chat(req);
      await cancelAndReopen(c, task.id);
      return result;
    };
    await c.runner.run({ taskId: task.id, kind: 'execute' });
    expect(await c.tasks.get(task.id)).toMatchObject({ activeMs: 0, cycleBaseActiveMs: 0 });
  });
});
