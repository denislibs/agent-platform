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
    expect(r).toMatchObject({ destroyed: 2, failed: 1 });
    expect((await c.sandboxes.list()).map(s => s.taskId)).toEqual([a.id]);
  });

  test('a task whose user already replied is not timed out: the job will resume it', async () => {
    const c = setupAgent({ ...env, WAIT_USER_TIMEOUT_MS: '60000' });
    const task = await planned(c);
    await c.guard.pause(task, 'execute');
    await c.steps.append({ taskId: task.id, agent: 'user', payload: { type: 'message', role: 'user', text: 'EU' } });
    c.clock.advance(61_000);
    const r = await c.sweeper.sweep();
    expect(r.timedOut).toBe(0);
    expect(r.failed).toBe(0);
    expect((await c.tasks.get(task.id))?.status).toBe('waiting_user');
    expect(c.queue.jobs.some(j => j.kind === 'finalize')).toBe(false);
  });

  test('a task resumed right before the transition stays running; the others are still timed out', async () => {
    const c = setupAgent({ ...env, WAIT_USER_TIMEOUT_MS: '60000' });
    const resumed = await planned(c);
    const silent = await planned(c);
    await c.tasks.transition(resumed.id, 'waiting_user', { currentKind: 'execute' });
    await c.tasks.transition(silent.id, 'waiting_user', { currentKind: 'execute' });
    c.clock.advance(61_000);
    // Job возобновил первую задачу уже после проверки ответа, прямо перед переходом в finalizing.
    const hasAnswer = c.guard.hasAnswer.bind(c.guard);
    c.guard.hasAnswer = async id => {
      const answered = await hasAnswer(id);
      if (id === resumed.id) await c.tasks.transition(id, 'running', { currentKind: 'execute' });
      return answered;
    };
    const r = await c.sweeper.sweep();
    expect(r).toMatchObject({ timedOut: 1, failed: 0 });
    expect((await c.tasks.get(resumed.id))?.status).toBe('running');
    expect(await c.tasks.get(silent.id)).toMatchObject({ status: 'finalizing', stopReason: 'wait_timeout' });
    expect(c.queue.jobs.map(j => [j.taskId, j.kind])).toEqual([[silent.id, 'finalize']]);
  });

  test('a failing enqueue is counted in failed and the other stale tasks are still requeued', async () => {
    const c = setupAgent(env);
    const a = await planned(c);
    const b = await planned(c);
    c.clock.advance(121_000);
    const enqueue = c.queue.enqueue.bind(c.queue);
    c.queue.enqueue = async (job, key) => {
      if (job.taskId === a.id) throw new Error('valkey is gone');
      return enqueue(job, key);
    };
    const r = await c.sweeper.sweep();
    expect(r).toMatchObject({ requeued: 1, failed: 1 });
    expect(c.queue.jobs.map(j => j.taskId)).toEqual([b.id]);
  });
});
