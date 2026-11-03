import { describe, expect, test } from 'bun:test';
import { InvalidTransitionError, LlmError } from '@agent/core';
import type { AgentJob } from '@agent/core';
import { calls, planned, seedTask, setupAgent } from './fixtures';

type C = ReturnType<typeof setupAgent>;
const sub = (goal: string) => ({ goal, done_criteria: `${goal} done` });

/** Как воркер: брать job из очереди и выполнять, пока очередь не опустеет (не больше limit). */
async function drain(c: C, opts: { twice?: boolean; limit?: number } = {}) {
  for (let i = 0; i < (opts.limit ?? 50); i++) {
    const job = c.queue.next();
    if (!job) return;
    await c.runner.run(job);
    if (opts.twice) await c.runner.run(job); // at-least-once: тот же job ещё раз
  }
  throw new Error('queue did not drain');
}

const script = (c: C) =>
  c.llm.push(
    calls(['create_plan', { subtasks: [sub('write')] }]),
    calls(['file_write', { path: 'outputs/hello.md', content: 'hi' }]),
    calls(['report', { summary: 'written', files: ['outputs/hello.md'] }]),
    calls(['accept', {}]),
    calls(['finish', { answer: 'Done', files: ['outputs/hello.md'] }]),
  );

/** Попытки job исчерпаны с «инфраструктурной» ошибкой. */
const fail = (c: C, job: AgentJob) => c.runner.onExhausted(job, new Error('docker exploded'));

describe('JobRunner', () => {
  test('a task runs from intake to done through the queue', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    script(c);
    await drain(c);
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'done', result: 'Done' });
    expect((await c.files.listForTask(task.id, 'output')).map(f => f.path)).toEqual(['outputs/hello.md']);
    expect(await c.sandboxes.list()).toEqual([{ id: `agent-sbx-${task.id}`, taskId: task.id, running: false }]);
    expect(c.llm.remaining).toBe(0);
  });

  test('every job delivered twice (at-least-once) gives the same result', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    script(c);
    await drain(c, { twice: true });
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'done', result: 'Done' });
    expect(await c.files.listForTask(task.id, 'output')).toHaveLength(1);
    expect(c.llm.remaining).toBe(0);
  });

  test('the next job is keyed by the task lastSeq', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    c.llm.push(calls(['create_plan', { subtasks: [sub('a')] }]));
    await c.runner.run(c.queue.next()!);
    const after = (await c.tasks.get(task.id))!;
    expect(c.queue.jobs).toEqual([
      { taskId: task.id, kind: 'execute', cycle: 1, key: `${task.id}.execute.${after.lastSeq}` },
    ]);
  });

  test('wait_user stops the sandbox; nothing is queued', async () => {
    const c = setupAgent();
    const task = await planned(c);
    c.llm.push(calls(['ask_user', { question: 'Which?' }]));
    expect(await c.runner.run({ taskId: task.id, kind: 'execute', cycle: 1 })).toEqual({ next: 'wait_user' });
    expect((await c.sandboxes.list()).find(s => s.taskId === task.id)?.running).toBe(false);
    expect(c.queue.jobs).toHaveLength(0);
  });

  test('stop on a cancelled task stops the sandbox and keeps its files; stop on a live task leaves it', async () => {
    const c = setupAgent();
    const task = await planned(c);
    const sandbox = await c.sandboxes.create(task.id);
    await sandbox.writeFile('notes.md', 'kept');
    await c.tasks.transition(task.id, 'cancelled');
    await c.runner.run({ taskId: task.id, kind: 'execute', cycle: 1 });
    expect((await c.sandboxes.list()).find(s => s.taskId === task.id)?.running).toBe(false);
    await sandbox.start();
    expect(new TextDecoder().decode(await sandbox.readFile('notes.md'))).toBe('kept');

    const live = await planned(c);
    await c.sandboxes.create(live.id);
    await c.tasks.transition(live.id, 'waiting_user', { currentKind: 'execute' });
    await c.runner.run({ taskId: live.id, kind: 'plan', cycle: 1 }); // устаревший job
    expect(await c.sandboxes.get(`agent-sbx-${live.id}`)).toBeDefined();
  });

  test('stop on a task deleted meanwhile destroys the sandbox', async () => {
    const c = setupAgent();
    const task = await planned(c);
    await c.sandboxes.create(task.id);
    await c.tasks.transition(task.id, 'cancelled');
    await c.tasks.delete(task.id);
    await c.runner.run({ taskId: task.id, kind: 'execute', cycle: 1 });
    expect(await c.sandboxes.list()).toEqual([]);
  });

  test('a retryable model error propagates for BullMQ to retry', async () => {
    const c = setupAgent();
    const task = await planned(c);
    c.llm.push(() => {
      throw new LlmError('rate_limited', 'slow down', true);
    });
    await expect(c.runner.run({ taskId: task.id, kind: 'execute', cycle: 1 })).rejects.toBeInstanceOf(LlmError);
  });

  test('a non-retryable model error finalises with a partial result', async () => {
    const c = setupAgent();
    const task = await planned(c);
    c.llm.push(() => {
      throw new LlmError('bad_request', 'tools invalid', false);
    });
    expect(await c.runner.run({ taskId: task.id, kind: 'execute', cycle: 1 })).toEqual({ next: 'finalize' });
    expect(await c.tasks.get(task.id)).toMatchObject({
      status: 'finalizing',
      partial: true,
      stopReason: 'model_error',
    });
    expect(c.queue.jobs.map(j => j.kind)).toEqual(['finalize']);
  });

  test('a failed model call charges no credits', async () => {
    const c = setupAgent();
    const task = await planned(c);
    const before = await c.ledger.balance(task.userId);
    c.llm.push(() => {
      throw new LlmError('bad_request', 'tools invalid', false);
    });
    await c.runner.run({ taskId: task.id, kind: 'execute', cycle: 1 });
    expect(await c.ledger.balance(task.userId)).toBe(before);
    expect((await c.tasks.get(task.id))?.tokensUsed).toBe(0);
  });

  describe('onExhausted', () => {
    test('fails the task when the job is still its current one, and stops the sandbox', async () => {
      const c = setupAgent();
      const task = await planned(c);
      await c.sandboxes.create(task.id);
      await fail(c, { taskId: task.id, kind: 'execute', cycle: 1 });
      expect(await c.tasks.get(task.id)).toMatchObject({ status: 'failed', stopReason: 'job_failed' });
      expect((await c.steps.list(task.id)).at(-1)?.payload).toMatchObject({
        type: 'status',
        to: 'failed',
        reason: 'docker exploded',
      });
      expect((await c.sandboxes.list()).find(s => s.taskId === task.id)?.running).toBe(false);
    });

    test('leaves the task alone for a stale job, a paused task or a finalizing task', async () => {
      const c = setupAgent();
      const a = await planned(c);
      await fail(c, { taskId: a.id, kind: 'review', cycle: 1 }); // currentKind execute
      expect((await c.tasks.get(a.id))?.status).toBe('running');

      const b = await planned(c);
      await c.tasks.transition(b.id, 'waiting_user', { currentKind: 'execute' });
      await fail(c, { taskId: b.id, kind: 'execute', cycle: 1 });
      expect((await c.tasks.get(b.id))?.status).toBe('waiting_user');

      const d = await planned(c);
      await c.tasks.transition(d.id, 'finalizing', { currentKind: 'finalize' });
      await fail(c, { taskId: d.id, kind: 'execute', cycle: 1 });
      expect((await c.tasks.get(d.id))?.status).toBe('finalizing');
    });

    test('an InvalidTransitionError reaching onExhausted fails the task like any other', async () => {
      const c = setupAgent();
      const task = await planned(c);
      await c.runner.onExhausted(
        { taskId: task.id, kind: 'execute', cycle: 1 },
        new InvalidTransitionError('task', task.id, 'x'),
      );
      expect((await c.tasks.get(task.id))?.status).toBe('failed');
    });

    test('fails a queued task whose plan job is exhausted', async () => {
      const c = setupAgent();
      const seeded = await seedTask(c);
      // TaskIntake ставит currentKind 'plan'; у queued без него kind всё равно plan.
      const task = await c.tasks.update(seeded.id, { currentKind: null });
      expect(task).toMatchObject({ status: 'queued', currentKind: null });
      await fail(c, { taskId: task.id, kind: 'plan', cycle: 1 });
      expect(await c.tasks.get(task.id)).toMatchObject({ status: 'failed', stopReason: 'job_failed' });
    });

    test('a task that moves on before the transition is left alone, with its sandbox', async () => {
      const c = setupAgent();
      const task = await planned(c);
      await c.sandboxes.create(task.id);
      // Между чтением задачи и переходом другой job переводит её в finalizing.
      const run = c.uow.run.bind(c.uow);
      c.uow.run = (async (fn: Parameters<typeof run>[0]) => {
        c.uow.run = run;
        await c.tasks.transition(task.id, 'finalizing', { currentKind: 'finalize' });
        return run(fn);
      }) as typeof c.uow.run;
      await fail(c, { taskId: task.id, kind: 'execute', cycle: 1 });
      expect((await c.tasks.get(task.id))?.status).toBe('finalizing');
      expect(await c.sandboxes.get(`agent-sbx-${task.id}`)).toBeDefined();
    });

    test('the reason has no control characters and is cut by code point', async () => {
      const c = setupAgent();
      const task = await planned(c);
      // Эмодзи занимает UTF-16 позиции 199–200: срез по единицам UTF-16 разрезал бы суррогатную пару.
      const message = `\u0000${'a'.repeat(198)}😀tail`;
      await c.runner.onExhausted({ taskId: task.id, kind: 'execute', cycle: 1 }, new Error(message));
      const payload = (await c.steps.list(task.id)).at(-1)?.payload;
      expect(payload).toMatchObject({ type: 'status', to: 'failed', reason: ` ${'a'.repeat(198)}😀` });
    });
  });

  test('a failing sandbox stop does not fail a stop job', async () => {
    const c = setupAgent();
    const task = await planned(c);
    await c.sandboxes.create(task.id);
    await c.tasks.transition(task.id, 'cancelled');
    const sandbox = (await c.sandboxes.get(`agent-sbx-${task.id}`))!;
    sandbox.stop = async () => {
      throw new Error('docker down');
    };
    expect(await c.runner.run({ taskId: task.id, kind: 'execute', cycle: 1 })).toEqual({ next: 'stop' });
  });

  test('a non-retryable model error on a task already finalizing queues finalize', async () => {
    const c = setupAgent();
    const task = await planned(c);
    // Модель отказала, а задача тем временем уже в finalizing (например, её перевёл другой job).
    c.llm.chat = async () => {
      await c.tasks.transition(task.id, 'finalizing', { currentKind: 'finalize' });
      throw new LlmError('bad_request', 'tools invalid', false);
    };
    expect(await c.runner.run({ taskId: task.id, kind: 'execute', cycle: 1 })).toEqual({ next: 'finalize' });
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'finalizing', partial: false, stopReason: null });
    expect(c.queue.jobs.map(j => j.kind)).toEqual(['finalize']);
  });
});
