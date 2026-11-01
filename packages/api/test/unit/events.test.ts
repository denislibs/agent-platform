import { describe, expect, test } from 'bun:test';
import { ApiErrorSchema, StepDtoSchema, StreamEndSchema } from '@agent/shared';
import { InMemoryStepLog } from '@agent/testing';
import { sseReader, type SseEvent } from '../sse';
import { setupApi, type ApiTest } from './helpers';

const note = (text: string) => ({ type: 'message', role: 'assistant', text }) as const;

async function taskWithSteps(t: ApiTest, userId: string, extra: number) {
  const task = await t.c.intake.create({ userId, prompt: 'p' }); // seq 1
  for (let i = 0; i < extra; i++)
    await t.c.steps.append({ taskId: task.id, agent: 'system', payload: note(`s${i + 2}`) });
  return task;
}

const seqOf = (data: string) => StepDtoSchema.parse(JSON.parse(data)).seq;

async function until(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await Bun.sleep(5);
  }
}

describe('GET /api/tasks/:id/events', () => {
  test('sends the steps after Last-Event-ID, then each new step as it is written', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const task = await taskWithSteps(t, user.id, 2);
    const res = await t.call('GET', `/api/tasks/${task.id}/events`, { headers: { ...headers, 'last-event-id': '1' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toStartWith('text/event-stream');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    const sse = sseReader(res);
    const first = await sse.next();
    expect(first).toMatchObject({ event: 'step', id: '2' });
    expect(seqOf(first!.data)).toBe(2);
    expect((await sse.next())?.id).toBe('3');

    await t.c.steps.append({ taskId: task.id, agent: 'system', payload: note('live') });
    const live = await sse.next();
    expect(live?.id).toBe('4');
    expect(StepDtoSchema.parse(JSON.parse(live!.data)).payload).toEqual(note('live'));
    await sse.cancel();
  });

  test('?after= works when there is no Last-Event-ID', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const task = await taskWithSteps(t, user.id, 2);
    const sse = sseReader(await t.call('GET', `/api/tasks/${task.id}/events?after=2`, { headers }));
    expect((await sse.next())?.id).toBe('3');
    await sse.cancel();
  });

  test('a cancelled task sends its last status step, then end, then closes the stream', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const task = await taskWithSteps(t, user.id, 0);
    const sse = sseReader(await t.call('GET', `/api/tasks/${task.id}/events`, { headers }));
    expect((await sse.next())?.id).toBe('1');
    expect((await t.call('POST', `/api/tasks/${task.id}/cancel`, { headers })).status).toBe(200);
    const status = await sse.next();
    expect(StepDtoSchema.parse(JSON.parse(status!.data)).payload).toEqual({
      type: 'status',
      from: 'queued',
      to: 'cancelled',
    });
    const end = await sse.next();
    expect(end?.event).toBe('end');
    expect(StreamEndSchema.parse(JSON.parse(end!.data))).toEqual({ status: 'cancelled' });
    expect(await sse.next()).toBeUndefined();
    expect(t.c.stepEvents.subscribers(task.id)).toBe(0);
  });

  test('connecting to a finished task replays the missed steps and ends at once', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const task = await taskWithSteps(t, user.id, 1);
    await t.c.tasks.transition(task.id, 'failed');
    const sse = sseReader(await t.call('GET', `/api/tasks/${task.id}/events`, { headers }));
    expect((await sse.next())?.id).toBe('1');
    expect((await sse.next())?.id).toBe('2');
    expect((await sse.next())?.event).toBe('end');
    expect(await sse.next()).toBeUndefined();
  });

  test('a lost notification is recovered by the heartbeat, which also pings the client', async () => {
    const t = setupApi({ SSE_HEARTBEAT_MS: '25' });
    const { user, headers } = await t.signIn();
    const task = await taskWithSteps(t, user.id, 0);
    const sse = sseReader(await t.call('GET', `/api/tasks/${task.id}/events`, { headers }));
    expect((await sse.next())?.id).toBe('1');
    // Запись мимо публикации: уведомления не будет, шаг найдёт только сердцебиение.
    await new InMemoryStepLog({ memory: t.c.memory }).append({
      taskId: task.id,
      agent: 'system',
      payload: note('quiet'),
    });
    // Без уведомления шаг находит только тик сердцебиения, а тик сначала шлёт ": ping".
    const seen: SseEvent[] = [];
    while (!seen.some(e => e.event === 'step')) {
      const event = await sse.next({ comments: true });
      if (!event) throw new Error('the stream closed early');
      seen.push(event);
    }
    expect(seen[0]?.event).toBe('comment');
    expect(seen.at(-1)).toMatchObject({ event: 'step', id: '2' });
    await sse.cancel();
  });

  test('the status reason of a failed step is sanitised in the stream', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const task = await taskWithSteps(t, user.id, 0);
    await t.c.steps.append({
      taskId: task.id,
      agent: 'system',
      payload: { type: 'status', from: 'running', to: 'failed', reason: 'spawn /usr/local/bin/docker ENOENT' },
    });
    const sse = sseReader(await t.call('GET', `/api/tasks/${task.id}/events?after=1`, { headers }));
    const step = StepDtoSchema.parse(JSON.parse((await sse.next())!.data));
    expect(step.payload).toEqual({ type: 'status', from: 'running', to: 'failed', reason: 'spawn <path> ENOENT' });
    await sse.cancel();
  });

  test('a client that goes away is unsubscribed', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const task = await taskWithSteps(t, user.id, 0);
    const sse = sseReader(await t.call('GET', `/api/tasks/${task.id}/events`, { headers }));
    await sse.next();
    expect(t.c.stepEvents.subscribers(task.id)).toBe(1);
    await sse.cancel();
    await until(() => t.c.stepEvents.subscribers(task.id) === 0);
  });

  test("a bad Last-Event-ID is 400; another user's task is 404; no session is 401", async () => {
    const t = setupApi();
    const owner = await t.signIn();
    const task = await taskWithSteps(t, owner.user.id, 0);
    const bad = await t.call('GET', `/api/tasks/${task.id}/events`, {
      headers: { ...owner.headers, 'last-event-id': 'x' },
    });
    expect(bad.status).toBe(400);
    const stranger = await t.signIn();
    expect((await t.call('GET', `/api/tasks/${task.id}/events`, { headers: stranger.headers })).status).toBe(404);
    expect((await t.call('GET', `/api/tasks/${task.id}/events`)).status).toBe(401);
  });

  test('?after= must be an integer ≥ 0', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const task = await taskWithSteps(t, user.id, 0);
    for (const after of ['-1', '1.5', '1e3', ' 1', 'abc', '9999999999']) {
      const res = await t.call('GET', `/api/tasks/${task.id}/events?after=${encodeURIComponent(after)}`, { headers });
      expect({ after, status: res.status }).toEqual({ after, status: 400 });
      expect(ApiErrorSchema.parse(await res.json()).error.code).toBe('bad_request');
    }
    expect(t.c.stepEvents.subscribers(task.id)).toBe(0);
  });

  test("a stranger's, an unknown and a malformed task id are the same 404, and no stream starts", async () => {
    const t = setupApi();
    const owner = await t.signIn();
    const task = await taskWithSteps(t, owner.user.id, 0);
    const stranger = await t.signIn();
    const bodies: string[] = [];
    for (const id of [task.id, crypto.randomUUID(), 'not-a-uuid']) {
      // Даже с кривым Last-Event-ID: проверка владельца раньше, чем разбор номера шага.
      const res = await t.call('GET', `/api/tasks/${id}/events`, {
        headers: { ...stranger.headers, 'last-event-id': 'x' },
      });
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toStartWith('application/json');
      bodies.push(await res.text());
    }
    expect(new Set(bodies).size).toBe(1);
    expect(t.c.stepEvents.subscribers(task.id)).toBe(0);
  });
});
