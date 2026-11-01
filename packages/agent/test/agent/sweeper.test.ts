import { describe, expect, test } from 'bun:test';
import { planned, seedTask, setupAgent } from './fixtures';

const env = { STALE_TASK_MS: '120000', WAIT_USER_TIMEOUT_MS: '86400000' };

describe('Sweeper', () => {
  test('re-queues stale tasks with the job that moves them on; fresh ones are left', async () => {
    const c = setupAgent(env);
    const queued = await seedTask(c);
    c.queue.next(); // задача создана, но её job потерян
    const running = await planned(c);
    await c.tasks.update(running.id, { currentKind: 'review' });
    c.clock.advance(121_000);
    const fresh = await planned(c);
    const r = await c.sweeper.sweep();
    expect(r.requeued).toBe(2);
    expect(c.queue.jobs.map(j => [j.taskId, j.kind]).toSorted()).toEqual(
      [
        [queued.id, 'plan'],
        [running.id, 'review'],
      ].toSorted(),
    );
    expect(c.queue.jobs.some(j => j.taskId === fresh.id)).toBe(false);
  });

  test('a second sweep does not duplicate a pending job', async () => {
    const c = setupAgent(env);
    await planned(c);
    c.clock.advance(121_000);
    await c.sweeper.sweep();
    await c.sweeper.sweep();
    expect(c.queue.jobs).toHaveLength(1);
  });

  test('a task waiting for the user past the timeout is finalised with wait_timeout', async () => {
    const c = setupAgent({ ...env, WAIT_USER_TIMEOUT_MS: '60000' });
    const task = await planned(c);
    await c.tasks.transition(task.id, 'waiting_user', { currentKind: 'execute' });
    c.clock.advance(61_000);
    const r = await c.sweeper.sweep();
    expect(r.timedOut).toBe(1);
    expect(await c.tasks.get(task.id)).toMatchObject({
      status: 'finalizing',
      partial: true,
      stopReason: 'wait_timeout',
    });
    expect(c.queue.jobs.map(j => j.kind)).toContain('finalize');
  });

  test('sandboxes of finished or missing tasks are destroyed; live ones are kept', async () => {
    const c = setupAgent(env);
    const done = await planned(c);
    await c.sandboxes.create(done.id);
    await c.tasks.transition(done.id, 'cancelled');
    await c.sandboxes.create('ghost-task');
    const live = await planned(c);
    await c.sandboxes.create(live.id);
    const r = await c.sweeper.sweep();
    expect(r.destroyed).toBe(2);
    expect((await c.sandboxes.list()).map(s => s.taskId)).toEqual([live.id]);
  });

  test('a failing sandbox destroy does not abort the sweep: the other sandboxes are still removed', async () => {
    const c = setupAgent(env);
    const a = await planned(c);
    const b = await planned(c);
    await c.tasks.transition(a.id, 'cancelled');
    await c.tasks.transition(b.id, 'cancelled');
    const broken = (await c.sandboxes.create(a.id)) as { destroy(): Promise<void> };
    broken.destroy = () => Promise.reject(new Error('docker is gone'));
    await c.sandboxes.create(b.id);
    await c.sandboxes.create('ghost-task');
    const r = await c.sweeper.sweep();
    expect(r.destroyed).toBe(2);
    expect((await c.sandboxes.list()).map(s => s.taskId)).toEqual([a.id]);
  });

  test('a task that left waiting_user meanwhile does not abort the timeout pass', async () => {
    const c = setupAgent({ ...env, WAIT_USER_TIMEOUT_MS: '60000' });
    const answered = await planned(c);
    const silent = await planned(c);
    await c.tasks.transition(answered.id, 'waiting_user', { currentKind: 'execute' });
    await c.tasks.transition(silent.id, 'waiting_user', { currentKind: 'execute' });
    c.clock.advance(61_000);
    // Пользователь ответил между выборкой и переходом: первая задача уже не в waiting_user.
    const findStale = c.tasks.findStale.bind(c.tasks);
    c.tasks.findStale = async opts => {
      const found = await findStale(opts);
      if (opts.statuses.includes('waiting_user'))
        await c.tasks.transition(answered.id, 'running', { currentKind: 'execute' });
      return found;
    };
    const r = await c.sweeper.sweep();
    expect(r.timedOut).toBe(1);
    expect(await c.tasks.get(silent.id)).toMatchObject({ status: 'finalizing', stopReason: 'wait_timeout' });
  });
});
