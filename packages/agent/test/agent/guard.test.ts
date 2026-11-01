import { describe, expect, test } from 'bun:test';
import { seedTask, setupAgent } from './fixtures';

describe('TaskGuard', () => {
  test('ok for a live task within limits', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    expect(await c.guard.check(task.id)).toMatchObject({ kind: 'ok', task: { id: task.id } });
  });

  test('stop for an unknown, cancelled or finished task', async () => {
    const c = setupAgent();
    expect(await c.guard.check('00000000-0000-4000-8000-0000000000ff')).toEqual({ kind: 'stop' });
    const task = await seedTask(c);
    await c.tasks.transition(task.id, 'cancelled');
    expect(await c.guard.check(task.id)).toEqual({ kind: 'stop' });
  });

  test('token budget is spent at 95 %', async () => {
    const c = setupAgent({ TASK_TOKEN_BUDGET: '1000' });
    const task = await seedTask(c);
    await c.ledger.record({
      userId: task.userId,
      taskId: task.id,
      model: 'm',
      tokensIn: 949,
      tokensOut: 0,
      millicredits: 1,
    });
    expect((await c.guard.check(task.id)).kind).toBe('ok');
    await c.ledger.record({
      userId: task.userId,
      taskId: task.id,
      model: 'm',
      tokensIn: 1,
      tokensOut: 0,
      millicredits: 1,
    });
    expect(await c.guard.check(task.id)).toMatchObject({ kind: 'limit', reason: 'token_budget' });
  });

  test('wall time counts only active time', async () => {
    const c = setupAgent({ TASK_WALL_TIME_MS: '60000' });
    const task = await seedTask(c);
    await c.tasks.update(task.id, { activeMs: 59_999 });
    expect((await c.guard.check(task.id)).kind).toBe('ok');
    await c.tasks.update(task.id, { activeMs: 60_000 });
    expect(await c.guard.check(task.id)).toMatchObject({ kind: 'limit', reason: 'wall_time' });
  });

  test('credits: a balance of zero or below is a limit', async () => {
    const c = setupAgent();
    const task = await seedTask(c, { millicredits: 5 });
    await c.ledger.record({
      userId: task.userId,
      taskId: task.id,
      model: 'm',
      tokensIn: 1,
      tokensOut: 1,
      millicredits: 5,
    });
    expect(await c.guard.check(task.id)).toMatchObject({ kind: 'limit', reason: 'credits' });
  });

  test('stopForLimit finalises with a partial result and writes a status step', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    await c.tasks.transition(task.id, 'planning');
    await c.guard.stopForLimit((await c.tasks.get(task.id))!, 'token_budget');
    expect(await c.tasks.get(task.id)).toMatchObject({
      status: 'finalizing',
      partial: true,
      stopReason: 'token_budget',
      currentKind: 'finalize',
    });
    const steps = await c.steps.list(task.id);
    expect(steps.at(-1)?.payload).toEqual({
      type: 'status',
      from: 'planning',
      to: 'finalizing',
      reason: 'token_budget',
    });
  });

  test('addActiveTime adds the elapsed clock time', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    const started = c.clock.now();
    c.clock.advance(1500);
    await c.guard.addActiveTime(task.id, started);
    c.clock.advance(500);
    await c.guard.addActiveTime(task.id, new Date(c.clock.now().getTime() - 500));
    expect((await c.tasks.get(task.id))?.activeMs).toBe(2000);
  });

  test('hasAnswer: only a user message after the latest pause counts', async () => {
    const c = setupAgent();
    const task = await seedTask(c); // первый шаг — запрос пользователя, он до паузы
    const running = await c.tasks.transition(task.id, 'planning', { currentKind: 'plan' });
    expect(await c.guard.hasAnswer(task.id)).toBe(false);
    await c.guard.pause(running, 'plan');
    expect(await c.guard.hasAnswer(task.id)).toBe(false);
    await c.steps.append({
      taskId: task.id,
      agent: 'system',
      payload: { type: 'message', role: 'user', text: 'not an answer', kind: 'note' },
    });
    expect(await c.guard.hasAnswer(task.id)).toBe(false);
    await c.steps.append({ taskId: task.id, agent: 'user', payload: { type: 'message', role: 'user', text: 'EU' } });
    expect(await c.guard.hasAnswer(task.id)).toBe(true);
    // Вторая пауза: прежний ответ к ней не относится.
    const resumed = await c.guard.resume((await c.tasks.get(task.id))!);
    await c.guard.pause(resumed, 'plan');
    expect(await c.guard.hasAnswer(task.id)).toBe(false);
  });
});
