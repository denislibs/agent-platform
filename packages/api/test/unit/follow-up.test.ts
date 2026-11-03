import { describe, expect, test } from 'bun:test';
import { jobKey } from '@agent/agent';
import { ApiErrorSchema, TaskEnvelopeSchema, type TaskStatus } from '@agent/shared';
import { setupApi, type ApiTest } from './helpers';

const errorCode = async (res: Response) => ApiErrorSchema.parse(await res.json()).error.code;
const contract = (goal: string) => ({ goal, context: '', doneCriteria: 'done', expectedOutputs: [] });

/** Задача в конечном статусе: job плана забран, в прошлом цикле потрачены токены и время. */
async function finished(t: ApiTest, userId: string, status: Extract<TaskStatus, 'done' | 'failed' | 'cancelled'>) {
  const { c } = t;
  const task = await c.intake.create({ userId, prompt: 'Build a page' });
  c.queue.next();
  await c.tasks.transition(task.id, 'planning', { currentKind: 'plan' });
  await c.ledger.record({ userId, taskId: task.id, model: 'q', tokensIn: 70, tokensOut: 30, millicredits: 1 });
  await c.tasks.update(task.id, { activeMs: 500 });
  if (status === 'done') {
    await c.tasks.transition(task.id, 'running');
    await c.tasks.transition(task.id, 'finalizing');
    await c.tasks.transition(task.id, 'done', { result: 'The page', finishedAt: c.clock.now() });
  } else {
    await c.tasks.transition(task.id, status, { stopReason: 'job_failed', finishedAt: c.clock.now() });
  }
  return (await c.tasks.get(task.id))!;
}

describe('POST /api/tasks/:id/messages on a finished task', () => {
  test.each(['done', 'failed', 'cancelled'] as const)(
    'a %s task is reopened: same task, a new cycle, cleared result and limits counted from now',
    async status => {
      const t = setupApi();
      const { user, headers } = await t.signIn();
      const task = await finished(t, user.id, status);
      const res = await t.call('POST', `/api/tasks/${task.id}/messages`, { headers, body: { text: 'Add a filter' } });
      expect(res.status).toBe(202);
      const after = (await t.c.tasks.get(task.id))!;
      expect(after).toMatchObject({
        status: 'planning',
        currentKind: 'plan',
        cycle: 2,
        cycleBaseTokens: 100,
        cycleBaseActiveMs: 500,
        tokensUsed: 100,
        activeMs: 500,
        partial: false,
        stopReason: null,
        result: null,
        finishedAt: null,
        prompt: 'Build a page',
      });
      expect(TaskEnvelopeSchema.parse(await res.json()).task).toMatchObject({
        id: task.id,
        cycle: 2,
        status: 'planning',
      });
      // Шаг status раньше сообщения: сообщение входит в новый цикл.
      expect((await t.c.steps.list(task.id)).slice(-2)).toMatchObject([
        { agent: 'user', payload: { type: 'status', from: status, to: 'planning' } },
        { agent: 'user', payload: { type: 'message', role: 'user', text: 'Add a filter' } },
      ]);
      expect(t.c.queue.jobs).toEqual([
        { taskId: task.id, kind: 'plan', cycle: 2, key: jobKey(task.id, 'plan', after.lastSeq) },
      ]);
    },
  );

  test('an answer to a question (questionSeq) never reopens a finished task: 409, nothing written or queued', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const task = await finished(t, user.id, 'cancelled');
    const res = await t.call('POST', `/api/tasks/${task.id}/messages`, {
      headers,
      body: { text: 'EU', questionSeq: task.lastSeq },
    });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('conflict');
    expect(await t.c.tasks.get(task.id)).toMatchObject({ status: 'cancelled', cycle: 1, lastSeq: task.lastSeq });
    expect(t.c.queue.jobs).toEqual([]);
  });

  test('no credits is 402 insufficient_credits: nothing changes', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn({ millicredits: 1 });
    const task = await finished(t, user.id, 'done');
    const res = await t.call('POST', `/api/tasks/${task.id}/messages`, { headers, body: { text: 'More' } });
    expect(res.status).toBe(402);
    expect(await errorCode(res)).toBe('insufficient_credits');
    expect(await t.c.tasks.get(task.id)).toMatchObject({ status: 'done', cycle: 1, result: 'The page' });
    expect(t.c.queue.jobs).toEqual([]);
  });

  test('too many active tasks is 429 too_many_active_tasks: nothing changes', async () => {
    const t = setupApi({ MAX_ACTIVE_TASKS_PER_USER: '1' });
    const { user, headers } = await t.signIn();
    const task = await finished(t, user.id, 'done');
    await t.c.intake.create({ userId: user.id, prompt: 'Another' });
    t.c.queue.next();
    const res = await t.call('POST', `/api/tasks/${task.id}/messages`, { headers, body: { text: 'More' } });
    expect(res.status).toBe(429);
    expect(await errorCode(res)).toBe('too_many_active_tasks');
    expect(await t.c.tasks.get(task.id)).toMatchObject({ status: 'done', cycle: 1 });
    expect(t.c.queue.jobs).toEqual([]);
  });

  test("another user's task and an unknown id are 404; a second send while it is planning is 409", async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const stranger = await t.signIn();
    const task = await finished(t, user.id, 'done');
    for (const [path, as] of [
      [`/api/tasks/${task.id}/messages`, stranger.headers],
      [`/api/tasks/${crypto.randomUUID()}/messages`, headers],
    ] as const)
      expect((await t.call('POST', path, { headers: as, body: { text: 'x' } })).status).toBe(404);
    await t.call('POST', `/api/tasks/${task.id}/messages`, { headers, body: { text: 'First' } });
    const second = await t.call('POST', `/api/tasks/${task.id}/messages`, { headers, body: { text: 'Second' } });
    expect(second.status).toBe(409);
    expect(await t.c.tasks.get(task.id)).toMatchObject({ cycle: 2 });
  });

  test('a failed enqueue does not lose the message: the sweeper queues the plan job', async () => {
    const t = setupApi({ STALE_TASK_MS: '120000' });
    const { user, headers } = await t.signIn();
    const task = await finished(t, user.id, 'done');
    const enqueue = t.c.queue.enqueue.bind(t.c.queue);
    t.c.queue.enqueue = () => Promise.reject(new Error('valkey is gone'));
    const res = await t.call('POST', `/api/tasks/${task.id}/messages`, { headers, body: { text: 'More' } });
    expect(res.status).toBe(202);
    expect(t.c.queue.jobs).toEqual([]);
    t.c.queue.enqueue = enqueue;
    t.c.clock.advance(121_000);
    await t.c.sweeper.sweep();
    const { lastSeq } = (await t.c.tasks.get(task.id))!;
    expect(t.c.queue.jobs).toEqual([
      { taskId: task.id, kind: 'plan', cycle: 2, key: jobKey(task.id, 'plan', lastSeq) },
    ]);
  });

  test('subtasks the last cycle left open are closed; finished ones stay; the numbering goes on', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const task = await t.c.intake.create({ userId: user.id, prompt: 'x' });
    t.c.queue.next();

    const [accepted, running, reviewing] = await t.c.subtasks.insertMany(task.id, ['a', 'b', 'c', 'd'].map(contract));
    await t.c.subtasks.transition(accepted!.id, 'running');
    await t.c.subtasks.transition(accepted!.id, 'reviewing');
    await t.c.subtasks.transition(accepted!.id, 'accepted');
    await t.c.subtasks.transition(running!.id, 'running');
    await t.c.subtasks.transition(reviewing!.id, 'running');
    await t.c.subtasks.transition(reviewing!.id, 'reviewing');
    await t.c.tasks.transition(task.id, 'cancelled');
    await t.call('POST', `/api/tasks/${task.id}/messages`, { headers, body: { text: 'Again' } });
    expect((await t.c.subtasks.list(task.id)).map(s => s.status)).toEqual(['accepted', 'failed', 'failed', 'skipped']);
    expect(await t.c.subtasks.nextPending(task.id)).toBeUndefined();
    const [next] = await t.c.subtasks.insertMany(task.id, [contract('e')]);
    expect(next).toMatchObject({ idx: 4, cycle: 2 });
  });

  test('a done task without an answer step gets one from its result, before the new cycle', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const task = await finished(t, user.id, 'done');
    await t.c.files.insert({
      userId: user.id,
      taskId: task.id,
      kind: 'output',
      path: 'outputs/page.html',
      storageKey: `tasks/${task.id}/outputs/page.html`,
      size: 1,
      mime: 'text/html',
    });
    await t.call('POST', `/api/tasks/${task.id}/messages`, { headers, body: { text: 'More' } });
    expect((await t.c.steps.list(task.id)).slice(-3)).toMatchObject([
      { agent: 'planner', payload: { kind: 'answer', text: 'The page', files: ['outputs/page.html'] } },
      { payload: { type: 'status', from: 'done', to: 'planning' } },
      { payload: { type: 'message', text: 'More' } },
    ]);
  });

  test('the result of a task cancelled while finalizing is not an answer', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const task = await finished(t, user.id, 'cancelled');
    await t.c.tasks.update(task.id, { result: 'half-written' });
    const res = await t.call('POST', `/api/tasks/${task.id}/messages`, { headers, body: { text: 'More' } });
    expect(res.status).toBe(202);
    const steps = await t.c.steps.list(task.id);
    expect(steps.some(s => s.payload.type === 'message' && s.payload.kind === 'answer')).toBe(false);
  });

  test('a reopened task counts as active for the account deletion', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const task = await finished(t, user.id, 'done');
    t.c.clock.advance(11 * 60_000);
    await t.call('POST', `/api/tasks/${task.id}/messages`, { headers, body: { text: 'More' } });
    const res = await t.call('DELETE', '/api/me', { headers, body: { email: user.email } });
    expect(res.status).toBe(409);
    expect(ApiErrorSchema.parse(await res.json()).error.message).toContain('running tasks');
  });

  test('a reopened task can be stopped and cannot be deleted until then', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const task = await finished(t, user.id, 'done');
    await t.call('POST', `/api/tasks/${task.id}/messages`, { headers, body: { text: 'More' } });
    expect((await t.call('DELETE', `/api/tasks/${task.id}`, { headers })).status).toBe(409);
    const stopped = await t.call('POST', `/api/tasks/${task.id}/cancel`, { headers });
    expect(stopped.status).toBe(200);
    expect(await t.c.tasks.get(task.id)).toMatchObject({ status: 'cancelled', cycle: 2 });
    expect((await t.call('DELETE', `/api/tasks/${task.id}`, { headers })).status).toBe(204);
  });
});
