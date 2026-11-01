import { describe, expect, test } from 'bun:test';
import { jobKey } from '@agent/agent';
import { InvalidTransitionError, type TxRepositories } from '@agent/core';
import { ApiErrorSchema, TaskEnvelopeSchema } from '@agent/shared';
import { toolCall } from '@agent/testing';
import { cancelTask } from '../../src';
import { pausedTask, setupApi } from './helpers';

const errorCode = async (res: Response) => ApiErrorSchema.parse(await res.json()).error.code;

describe('POST /api/tasks/:id/messages', () => {
  test('records the answer, then queues the paused stage keyed by the lastSeq after the answer', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const task = await pausedTask(t, user.id);
    expect(task.lastSeq).toBe(2);

    const res = await t.call('POST', `/api/tasks/${task.id}/messages`, { headers, body: { text: 'EU only' } });
    expect(res.status).toBe(202);
    const body = TaskEnvelopeSchema.parse(await res.json());
    expect(body.task).toMatchObject({ status: 'waiting_user', lastSeq: 3 });
    const steps = await t.c.steps.list(task.id, { afterSeq: 2 });
    expect(steps).toMatchObject([
      { seq: 3, agent: 'user', payload: { type: 'message', role: 'user', text: 'EU only' } },
    ]);
    // Воркер пропускает первый запуск job, чей seq в ключе не равен lastSeq задачи (склейка дублей плана 3d):
    // ключ по seq до ответа (2) оставил бы задачу висеть навсегда.
    expect(t.c.queue.jobs).toEqual([{ taskId: task.id, kind: 'execute', key: jobKey(task.id, 'execute', 3) }]);
    expect(t.c.stepEvents.published.at(-1)).toEqual({ taskId: task.id, lastSeq: 3 });
  });

  test('the queued job resumes the task and the model continues with the answer', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const task = await pausedTask(t, user.id);
    await t.call('POST', `/api/tasks/${task.id}/messages`, { headers, body: { text: 'EU only' } });
    t.c.llm.push({
      toolCalls: [toolCall('report', { summary: 'EU suppliers listed' })],
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    const job = t.c.queue.next()!;
    expect(job.key).toBe(jobKey(task.id, 'execute', (await t.c.tasks.get(task.id))!.lastSeq));
    await t.c.runner.run({ taskId: job.taskId, kind: job.kind });
    expect((await t.c.tasks.get(task.id))?.status).toBe('running');
    const statuses = (await t.c.steps.list(task.id)).filter(s => s.payload.type === 'status').map(s => s.payload);
    expect(statuses).toContainEqual({ type: 'status', from: 'waiting_user', to: 'running' });
  });

  test('a task that is not waiting for an answer is 409, and nothing is written or queued', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const task = await t.c.intake.create({ userId: user.id, prompt: 'x' });
    t.c.queue.next();
    const res = await t.call('POST', `/api/tasks/${task.id}/messages`, { headers, body: { text: 'hi' } });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('conflict');
    expect((await t.c.tasks.get(task.id))?.lastSeq).toBe(1);
    expect(t.c.queue.jobs).toEqual([]);
  });

  test('if queueing fails the answer stays recorded, the failure is logged and the sweeper queues the job later', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const task = await pausedTask(t, user.id);
    const enqueue = t.c.queue.enqueue.bind(t.c.queue);
    t.c.queue.enqueue = async () => {
      throw new Error('valkey is gone');
    };
    const res = await t.call('POST', `/api/tasks/${task.id}/messages`, { headers, body: { text: 'EU only' } });
    expect(res.status).toBe(202);
    expect(t.c.logger.entries).toMatchObject([{ level: 'warn', fields: { taskId: task.id, error: 'valkey is gone' } }]);

    t.c.queue.enqueue = enqueue;
    t.c.clock.advance(t.c.config.worker.staleTaskMs + 1000);
    await t.c.sweeper.sweep();
    expect(t.c.queue.jobs).toEqual([{ taskId: task.id, kind: 'execute', key: jobKey(task.id, 'execute', 3) }]);
  });

  test("an empty answer is 400; another user's task is 404", async () => {
    const t = setupApi();
    const owner = await t.signIn();
    const task = await pausedTask(t, owner.user.id);
    expect(
      (await t.call('POST', `/api/tasks/${task.id}/messages`, { headers: owner.headers, body: { text: ' ' } })).status,
    ).toBe(400);
    const stranger = await t.signIn();
    const res = await t.call('POST', `/api/tasks/${task.id}/messages`, {
      headers: stranger.headers,
      body: { text: 'hi' },
    });
    expect(res.status).toBe(404);
  });

  test('a lone surrogate in the answer is 400, and nothing is written or queued', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const task = await pausedTask(t, user.id);
    const res = await t.call('POST', `/api/tasks/${task.id}/messages`, { headers, body: { text: 'EU\udc00' } });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('bad_request');
    expect((await t.c.tasks.get(task.id))!.lastSeq).toBe(2);
    expect(t.c.queue.jobs).toEqual([]);
  });

  test('two replies to the same pause are both accepted while the task waits, each keyed by its own lastSeq', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const task = await pausedTask(t, user.id);
    const [first, second] = await Promise.all([
      t.call('POST', `/api/tasks/${task.id}/messages`, { headers, body: { text: 'EU only' } }),
      t.call('POST', `/api/tasks/${task.id}/messages`, { headers, body: { text: 'and under 50 people' } }),
    ]);
    expect([first.status, second.status]).toEqual([202, 202]);
    const messages = (await t.c.steps.list(task.id, { afterSeq: 2 })).map(s => [s.seq, s.payload.type]);
    expect(messages).toEqual([
      [3, 'message'],
      [4, 'message'],
    ]);
    // Воркер пропустит job с seq 3 (задача уже на 4) и выполнит job с seq 4; модель увидит оба ответа.
    expect(t.c.queue.jobs.map(j => j.key)).toEqual([jobKey(task.id, 'execute', 3), jobKey(task.id, 'execute', 4)]);
  });

  test('a reply that loses the race to the worker resuming the task is 409, and nothing stays recorded or queued', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const task = await pausedTask(t, user.id);
    const run = t.c.uow.run.bind(t.c.uow);
    // Воркер успел снять паузу между проверкой статуса и записью ответа: после append задача уже running.
    t.c.uow.run = <T>(fn: (tx: TxRepositories) => Promise<T>): Promise<T> =>
      run(tx =>
        fn({
          ...tx,
          steps: {
            ...tx.steps,
            append: async input => {
              const step = await tx.steps.append(input);
              await tx.tasks.transition(task.id, 'running', {}, { expectedFrom: 'waiting_user' });
              return step;
            },
          },
        }),
      );
    const res = await t.call('POST', `/api/tasks/${task.id}/messages`, { headers, body: { text: 'EU only' } });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('conflict');
    expect(t.c.queue.jobs).toEqual([]);
    expect((await t.c.tasks.get(task.id))?.lastSeq).toBe(2);
  });
});

describe('POST /api/tasks/:id/cancel', () => {
  test('cancels a live task with finishedAt and a status step from the user; a repeat is a no-op', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const task = await t.c.intake.create({ userId: user.id, prompt: 'x' });
    const res = await t.call('POST', `/api/tasks/${task.id}/cancel`, { headers });
    expect(res.status).toBe(200);
    const { task: cancelled } = TaskEnvelopeSchema.parse(await res.json());
    expect(cancelled).toMatchObject({ status: 'cancelled', finishedAt: t.c.clock.now().toISOString(), lastSeq: 2 });
    expect((await t.c.steps.list(task.id, { afterSeq: 1 }))[0]).toMatchObject({
      agent: 'user',
      payload: { type: 'status', from: 'queued', to: 'cancelled' },
    });
    expect(t.c.stepEvents.published.at(-1)).toEqual({ taskId: task.id, lastSeq: 2 });

    const again = await t.call('POST', `/api/tasks/${task.id}/cancel`, { headers });
    expect(again.status).toBe(200);
    expect(TaskEnvelopeSchema.parse(await again.json()).task.lastSeq).toBe(2);
  });

  test('csrf: a cancel from a foreign Origin is 403 forbidden and changes nothing; same-origin passes', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const task = await t.c.intake.create({ userId: user.id, prompt: 'x' });
    for (const foreign of [
      { origin: 'https://evil.example' },
      // Порт — часть Origin: соседнее приложение на том же хосте тоже чужое.
      { origin: 'http://localhost:3001' },
      { origin: 'null' },
    ]) {
      const res = await t.call('POST', `/api/tasks/${task.id}/cancel`, { headers: { ...headers, ...foreign } });
      expect({ foreign, status: res.status }).toEqual({ foreign, status: 403 });
      expect(await errorCode(res)).toBe('forbidden');
    }
    // Ни Origin, ни Sec-Fetch-Site: браузер так не шлёт, отклоняем.
    const { origin: _, ...bare } = headers;
    expect((await t.app.request(`/api/tasks/${task.id}/cancel`, { method: 'POST', headers: bare })).status).toBe(403);
    expect((await t.c.tasks.get(task.id))?.status).toBe('queued');

    // Sec-Fetch-Site: same-origin без Origin — тоже свой.
    const viaFetchSite = await t.app.request(`/api/tasks/${task.id}/cancel`, {
      method: 'POST',
      headers: { ...bare, 'sec-fetch-site': 'same-origin' },
    });
    expect(viaFetchSite.status).toBe(200);
    expect((await t.call('POST', `/api/tasks/${task.id}/cancel`, { headers })).status).toBe(200);
  });

  test('csrf does not cover /api/auth/* (Better Auth checks Origin itself) nor GET', async () => {
    const t = setupApi();
    const { headers } = await t.signIn();
    const foreign = { origin: 'https://evil.example' };
    expect((await t.call('POST', '/api/auth/sign-out', { headers: foreign })).status).toBe(200);
    expect((await t.call('GET', '/api/me', { headers: { ...headers, ...foreign } })).status).toBe(200);
  });

  test('csrf runs after the session guard: a foreign POST without a session is still 401', async () => {
    const t = setupApi();
    const task = crypto.randomUUID();
    const res = await t.call('POST', `/api/tasks/${task}/cancel`, { headers: { origin: 'https://evil.example' } });
    expect(res.status).toBe(401);
  });

  test('a paused task can be cancelled; the worker then stops at its next check', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const task = await pausedTask(t, user.id);
    expect((await t.call('POST', `/api/tasks/${task.id}/cancel`, { headers })).status).toBe(200);
    expect(await t.c.guard.check(task.id)).toEqual({ kind: 'stop' });
  });

  test('cancel re-reads and retries when the worker changed the status under it', async () => {
    const t = setupApi();
    const { user } = await t.signIn();
    const task = await t.c.intake.create({ userId: user.id, prompt: 'x' });
    let calls = 0;
    // Первая транзакция «проигрывает гонку»: так выглядит переход с устаревшим expectedFrom.
    const uow = {
      run: async <T>(fn: (tx: TxRepositories) => Promise<T>): Promise<T> => {
        calls++;
        if (calls === 1) throw new InvalidTransitionError('task', task.id, 'cancelled');
        return t.c.uow.run(fn);
      },
    };
    const cancelled = await cancelTask({ uow, clock: t.c.clock }, task.id);
    expect(cancelled.status).toBe('cancelled');
    expect(calls).toBe(2);
  });

  test('cancel gives up after three lost races', async () => {
    const t = setupApi();
    const { user } = await t.signIn();
    const task = await t.c.intake.create({ userId: user.id, prompt: 'x' });
    let calls = 0;
    const uow = {
      // Без параметра: fn не вызывается, а функция с меньшим числом параметров подходит к UnitOfWork.run.
      run: async <T>(): Promise<T> => {
        calls++;
        throw new InvalidTransitionError('task', task.id, 'cancelled');
      },
    };
    await expect(cancelTask({ uow, clock: t.c.clock }, task.id)).rejects.toBeInstanceOf(InvalidTransitionError);
    expect(calls).toBe(3);
  });

  test('a task that became failed during the race is 409, one that became cancelled is the same task', async () => {
    const t = setupApi();
    const { user } = await t.signIn();
    const lostTo = async (to: 'failed' | 'cancelled') => {
      const task = await t.c.intake.create({ userId: user.id, prompt: 'x' });
      let calls = 0;
      const uow = {
        run: async <T>(fn: (tx: TxRepositories) => Promise<T>): Promise<T> => {
          if (++calls === 1) {
            await t.c.tasks.transition(task.id, to);
            throw new InvalidTransitionError('task', task.id, 'cancelled');
          }
          return t.c.uow.run(fn);
        },
      };
      return cancelTask({ uow, clock: t.c.clock }, task.id);
    };
    await expect(lostTo('failed')).rejects.toMatchObject({ status: 409, code: 'conflict' });
    expect((await lostTo('cancelled')).status).toBe('cancelled');
  });

  test('a finished task is 409; a foreign one is 404', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const task = await t.c.intake.create({ userId: user.id, prompt: 'x' });
    await t.c.tasks.transition(task.id, 'failed');
    const res = await t.call('POST', `/api/tasks/${task.id}/cancel`, { headers });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('conflict');
    const stranger = await t.signIn();
    expect((await t.call('POST', `/api/tasks/${task.id}/cancel`, { headers: stranger.headers })).status).toBe(404);
  });
});
