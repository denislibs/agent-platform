import { describe, expect, test } from 'bun:test';
import { LlmError, type AgentJob } from '@agent/core';
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

/**
 * Шаги после открытия заново: только статус и сообщение пользователя, старый job не дописал ничего.
 * Job старого цикла в очереди допустим, если разрешён: он ничего не делает, его останавливает сверка цикла.
 */
async function expectNewCycleUntouched(c: C, taskId: string, opts: { staleJobs?: boolean } = {}) {
  const steps = await c.steps.list(taskId);
  const at = steps.findLastIndex(s => s.payload.type === 'status' && s.payload.to === 'planning');
  expect(steps.slice(at)).toMatchObject([
    { payload: { type: 'status', from: 'cancelled', to: 'planning' } },
    { agent: 'user', payload: { type: 'message', text: 'Changed my mind' } },
  ]);
  const task = (await c.tasks.get(taskId))!;
  expect(task).toMatchObject({ status: 'planning', cycle: 2, currentKind: 'plan', result: null });
  // Единственный job — тот, что поставило открытие заново: второй цепочки нет.
  const jobs = opts.staleJobs ? c.queue.jobs.filter(j => j.cycle === task.cycle) : c.queue.jobs;
  expect(jobs).toEqual([{ taskId, kind: 'plan', cycle: 2, key: jobKey(taskId, 'plan', task.lastSeq) }]);
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

    expect(await c.runner.run({ taskId: task.id, kind: 'plan', cycle: 1 })).toEqual({ next: 'stop' });

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
    await c.runner.run({ taskId: task.id, kind: 'plan', cycle: 1 });

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

    expect(await c.runner.run({ taskId: task.id, kind: 'execute', cycle: 1 })).toEqual({ next: 'stop' });

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

    expect(await c.runner.run({ taskId: task.id, kind: 'execute', cycle: 1 })).toEqual({ next: 'stop' });

    expect(commands).toEqual(['first']);
    await expectNewCycleUntouched(c, task.id);
  });

  test('review: the late accept is not applied', async () => {
    const c = setupAgent();
    const task = await reviewing(c);
    c.llm.push(calls(['accept', {}]));
    reopenDuringNextCall(c, task.id);

    expect(await c.runner.run({ taskId: task.id, kind: 'review', cycle: 1 })).toEqual({ next: 'stop' });

    await expectNewCycleUntouched(c, task.id);
    expect(await c.subtasks.list(task.id)).toMatchObject([{ status: 'failed' }]);
  });

  test('finalize: the late answer writes no result and does not finish the new cycle', async () => {
    const c = setupAgent();
    const task = await finalizing(c);
    c.llm.push(calls(['finish', { answer: 'late answer', files: [] }]));
    reopenDuringNextCall(c, task.id);

    expect(await c.runner.run({ taskId: task.id, kind: 'finalize', cycle: 1 })).toEqual({ next: 'stop' });

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

    expect(await c.runner.run({ taskId: task.id, kind: 'finalize', cycle: 1 })).toEqual({ next: 'stop' });

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
      expect(await c.runner.run({ taskId: task.id, kind: 'execute', cycle: 1 })).toEqual({ next: 'stop' });
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
    await c.runner.run({ taskId: task.id, kind: 'execute', cycle: 1 });
    expect(await c.tasks.get(task.id)).toMatchObject({ activeMs: 0, cycleBaseActiveMs: 0 });
  });
});

const unavailable = (retryable: boolean) => new LlmError('unavailable', 'the model is down', retryable);

describe('a retry or an exhausted job of an old cycle', () => {
  test('a retry after the task was reopened does nothing, and neither does its exhaustion', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    c.queue.next();
    const job: AgentJob = { taskId: task.id, kind: 'plan', cycle: 1 };
    let attempts = 0;
    c.llm.chat = async () => {
      attempts++;
      throw unavailable(true);
    };
    await expect(c.runner.run(job)).rejects.toBeInstanceOf(LlmError);
    await cancelAndReopen(c, task.id); // пока BullMQ ждёт перед повтором

    expect(await c.runner.run(job)).toEqual({ next: 'stop' });
    await c.runner.onExhausted(job, unavailable(true));

    expect(attempts).toBe(1);
    await expectNewCycleUntouched(c, task.id);
  });

  test('a retry in the same cycle still runs, and its exhaustion still fails the task', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    c.queue.next();
    const chat = c.llm.chat.bind(c.llm);
    c.llm.chat = async () => {
      c.llm.chat = chat;
      throw unavailable(true);
    };
    c.llm.push(calls(['create_plan', { subtasks: [{ goal: 'plan', done_criteria: 'x' }] }]));
    const job: AgentJob = { taskId: task.id, kind: 'plan', cycle: 1 };
    await expect(c.runner.run(job)).rejects.toBeInstanceOf(LlmError);

    expect(await c.runner.run(job)).toEqual({ next: 'execute' });
    expect(c.queue.jobs).toMatchObject([{ taskId: task.id, kind: 'execute', cycle: 1 }]);

    await c.runner.onExhausted({ taskId: task.id, kind: 'execute', cycle: 1 }, new Error('docker exploded'));
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'failed', stopReason: 'job_failed', cycle: 1 });
  });

  test('a job queued before cycles existed has no cycle and counts as the current one', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    c.queue.next();
    c.llm.push(calls(['create_plan', { subtasks: [{ goal: 'plan', done_criteria: 'x' }] }]));
    const legacy = (kind: AgentJob['kind']) => ({ taskId: task.id, kind }) as AgentJob;

    expect(await c.runner.run(legacy('plan'))).toEqual({ next: 'execute' });
    expect(c.queue.jobs).toMatchObject([{ taskId: task.id, kind: 'execute', cycle: 1 }]);

    await c.runner.onExhausted(legacy('execute'), new Error('docker exploded'));
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'failed', stopReason: 'job_failed' });
  });

  test('the old job exhausted after the reopen does not fail the new cycle whatever it was running', async () => {
    const c = setupAgent();
    const task = await planned(c);
    await cancelAndReopen(c, task.id);
    c.queue.next(); // plan, который поставило открытие заново
    // Тот же kind, что у нового цикла: сверка по kind его бы не отличила.
    await c.runner.onExhausted({ taskId: task.id, kind: 'plan', cycle: 1 }, new Error('docker exploded'));
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'planning', cycle: 2 });
  });

  test('exhaustion that races a reopen between its read and its write does not fail the new cycle', async () => {
    const c = setupAgent();
    const task = await planned(c);
    const write = c.guard.write.bind(c.guard);
    c.guard.write = async (target, act) => {
      c.guard.write = write;
      await cancelAndReopen(c, task.id);
      return write(target, act);
    };
    await c.runner.onExhausted({ taskId: task.id, kind: 'execute', cycle: 1 }, new Error('docker exploded'));
    await expectNewCycleUntouched(c, task.id);
  });

  test('a model failure with a reopen between any two reads never finalizes the new cycle', async () => {
    let reopenedRuns = 0;
    for (let after = 0; after < 8; after++) {
      const c = setupAgent();
      const task = await planned(c);
      let failed = false;
      let reopened = false;
      let reads = 0;
      c.llm.chat = async () => {
        failed = true;
        throw unavailable(false);
      };
      const get = c.tasks.get.bind(c.tasks);
      c.tasks.get = async id => {
        const found = await get(id);
        if (failed && !reopened && reads++ === after) {
          reopened = true;
          await cancelAndReopen(c, task.id);
        }
        return found;
      };

      const outcome = await c.runner.run({ taskId: task.id, kind: 'execute', cycle: 1 });

      if (reopened) {
        // Исход зависит от того, до какого чтения дошла стадия (отказ уже мог законно перевести цикл 1 в finalizing);
        // новый цикл не тронут в любом случае, а оставшийся от старого цикла job в очереди ничего не делает.
        reopenedRuns++;
        for (const stale of c.queue.jobs.filter(j => j.cycle === 1))
          expect(await c.runner.run(stale)).toEqual({ next: 'stop' });
        await expectNewCycleUntouched(c, task.id, { staleJobs: true });
      } else {
        expect(outcome).toEqual({ next: 'finalize' });
      }
    }
    expect(reopenedRuns).toBeGreaterThan(2);
  });

  test('a job of the old cycle taken from the queue after the reopen stops without calling the model', async () => {
    const c = setupAgent();
    const task = await planned(c);
    c.queue.next();
    await cancelAndReopen(c, task.id);
    c.queue.next();
    const llmCalls: unknown[] = [];
    c.llm.chat = async req => {
      llmCalls.push(req);
      throw unavailable(false);
    };
    expect(await c.runner.run({ taskId: task.id, kind: 'finalize', cycle: 1 })).toEqual({ next: 'stop' });
    expect(llmCalls).toEqual([]);
    expect(c.queue.jobs).toEqual([]);
  });
});

describe('time and tool calls of an old job', () => {
  test('active time added while the task is reopened lands in neither cycle', async () => {
    for (const reopenFirst of [false, true]) {
      const c = setupAgent();
      const task = await seedTask(c);
      const started = c.clock.now();
      c.clock.advance(5000);
      const add = c.guard.addActiveTime(task.id, started, 1);
      const reopen = cancelAndReopen(c, task.id);
      await Promise.all(reopenFirst ? [reopen, add] : [add, reopen]);
      const after = (await c.tasks.get(task.id))!;
      expect(after.cycle).toBe(2);
      expect(after.activeMs - after.cycleBaseActiveMs).toBe(0);
    }
  });

  test('active time is not added when the reopen lands between the read and the write', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    const started = c.clock.now();
    c.clock.advance(5000);
    const get = c.tasks.get.bind(c.tasks);
    let reopened = false;
    c.tasks.get = async id => {
      const found = await get(id);
      if (!reopened) {
        reopened = true;
        await cancelAndReopen(c, task.id);
      }
      return found;
    };
    await c.guard.addActiveTime(task.id, started, 1);
    c.tasks.get = get;
    const after = (await c.tasks.get(task.id))!;
    expect(after.activeMs - after.cycleBaseActiveMs).toBe(after.cycle === 1 ? 5000 : 0);
  });

  test('a stage that outlives the reopen resolves with its value and charges the new cycle nothing', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    const value = await c.guard.timed(task.id, async () => {
      c.clock.advance(5000);
      await cancelAndReopen(c, task.id);
      return 'stage value';
    });
    expect(value).toBe('stage value');
    expect(await c.tasks.get(task.id)).toMatchObject({ activeMs: 0, cycleBaseActiveMs: 0, cycle: 2 });
  });

  test('execute: the next command of the turn does not start once the task was reopened after the previous result', async () => {
    const c = setupAgent();
    const task = await planned(c);
    const commands: string[] = [];
    c.sandboxes.handlers = {
      exec: async cmd => {
        commands.push(cmd);
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
      },
    };
    c.llm.push(calls(['shell', { cmd: 'first' }], ['shell', { cmd: 'second' }]));
    const write = c.guard.write.bind(c.guard);
    let reopened = false;
    c.guard.write = async (target, act) => {
      const result = await write(target, act);
      if (commands.length === 1 && !reopened) {
        reopened = true;
        await cancelAndReopen(c, task.id);
      }
      return result;
    };

    expect(await c.runner.run({ taskId: task.id, kind: 'execute', cycle: 1 })).toEqual({ next: 'stop' });

    expect(commands).toEqual(['first']);
    await expectNewCycleUntouched(c, task.id);
  });
});
