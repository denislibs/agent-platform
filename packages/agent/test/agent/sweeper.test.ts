import { describe, expect, test } from 'bun:test';
import { jobKey } from '../../src';
import { calls, planned, seedTask, setupAgent } from './fixtures';

const env = { STALE_TASK_MS: '120000', WAIT_USER_TIMEOUT_MS: '86400000', SANDBOX_RETENTION_MS: '3600000' };
const STALE_MS = 120_000;
const RETENTION_MS = 3_600_000;

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

  test('a re-queued job carries the cycle of its task', async () => {
    const c = setupAgent(env);
    const task = await planned(c);
    await c.tasks.update(task.id, { cycle: 3 });
    c.clock.advance(121_000);
    await c.sweeper.sweep();
    expect(c.queue.jobs).toMatchObject([{ taskId: task.id, kind: 'execute', cycle: 3 }]);
  });

  test('the finalize job of a timed-out wait carries the cycle of its task', async () => {
    const c = setupAgent({ ...env, WAIT_USER_TIMEOUT_MS: '60000' });
    const task = await planned(c);
    await c.tasks.update(task.id, { cycle: 3 });
    await c.guard.pause({ ...task, cycle: 3 }, 'execute');
    c.clock.advance(61_000);
    await c.sweeper.sweep();
    expect(c.queue.jobs).toMatchObject([{ taskId: task.id, kind: 'finalize', cycle: 3 }]);
  });

  test('a second sweep does not duplicate a pending job', async () => {
    const c = setupAgent(env);
    await planned(c);
    c.clock.advance(121_000);
    await c.sweeper.sweep();
    await c.sweeper.sweep();
    expect(c.queue.jobs).toHaveLength(1);
  });

  test('an answered waiting task whose job was lost is re-queued with its stage and the seq after the answer', async () => {
    const c = setupAgent(env);
    const answered = await planned(c);
    await c.guard.pause(answered, 'execute');
    await c.steps.append({
      taskId: answered.id,
      agent: 'user',
      payload: { type: 'message', role: 'user', text: 'EU' },
    });
    const silent = await planned(c);
    await c.guard.pause(silent, 'execute');
    c.clock.advance(121_000);
    const r = await c.sweeper.sweep();
    const after = await c.tasks.get(answered.id);
    expect(r.requeued).toBe(1);
    expect(c.queue.jobs).toEqual([
      { taskId: answered.id, kind: 'execute', cycle: 1, key: jobKey(answered.id, 'execute', after!.lastSeq) },
    ]);
    expect(after?.status).toBe('waiting_user');
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

  test('a sandbox of a finished task stays until SANDBOX_RETENTION_MS after the finish; of a missing task it goes at once; a live one is kept', async () => {
    const c = setupAgent(env);
    const done = await planned(c);
    await (await c.sandboxes.create(done.id)).stop();
    await c.tasks.transition(done.id, 'finalizing');
    await c.tasks.transition(done.id, 'done', { finishedAt: c.clock.now() });
    await c.sandboxes.create('ghost-task');
    const live = await planned(c);
    await c.sandboxes.create(live.id);

    expect(await c.sweeper.sweep()).toMatchObject({ destroyed: 1, stopped: 0 });
    expect((await c.sandboxes.list()).map(s => s.taskId).toSorted()).toEqual([done.id, live.id].toSorted());

    c.clock.advance(RETENTION_MS - 1);
    expect(await c.sweeper.sweep()).toMatchObject({ destroyed: 0, stopped: 0 });
    c.clock.advance(1);
    expect(await c.sweeper.sweep()).toMatchObject({ destroyed: 1, stopped: 0 });
    expect((await c.sandboxes.list()).map(s => s.taskId)).toEqual([live.id]);
  });

  test('a task reopened within the retention keeps its sandbox past the old deadline', async () => {
    const c = setupAgent(env);
    const task = await planned(c);
    await (await c.sandboxes.create(task.id)).stop();
    await c.tasks.transition(task.id, 'cancelled', { finishedAt: c.clock.now() });
    await c.intake.reopen({ taskId: task.id, userId: task.userId, text: 'More' });
    c.queue.next();
    c.clock.advance(RETENTION_MS + 1);
    expect((await c.sweeper.sweep()).destroyed).toBe(0);
    expect((await c.sandboxes.list()).map(s => s.taskId)).toEqual([task.id]);
  });

  test('a sandbox still running after a cancel is stopped only once its job has had time to end', async () => {
    const c = setupAgent(env);
    const task = await planned(c);
    await c.sandboxes.create(task.id);
    await c.tasks.transition(task.id, 'cancelled', { finishedAt: c.clock.now() });

    expect((await c.sweeper.sweep()).stopped).toBe(0);
    expect((await c.sandboxes.list())[0]?.running).toBe(true);

    c.clock.advance(STALE_MS);
    expect((await c.sweeper.sweep()).stopped).toBe(1);
    expect((await c.sandboxes.list())[0]?.running).toBe(false);
    expect((await c.sweeper.sweep()).stopped).toBe(0);
  });

  test('a command of a cancelled job cut by that stop ends the job without bringing the sandbox back', async () => {
    const c = setupAgent(env);
    const task = await planned(c);
    const sandbox = await c.sandboxes.create(task.id);
    let runs = 0;
    c.sandboxes.handlers = {
      exec: async () => {
        runs++;
        await c.tasks.transition(task.id, 'cancelled', { finishedAt: c.clock.now() });
        c.clock.advance(STALE_MS);
        await c.sweeper.sweep();
        return sandbox.exec('ls', { timeoutMs: 1000 });
      },
    };
    c.llm.push(calls(['shell', { cmd: 'long-running' }]));

    expect(await c.runner.run({ taskId: task.id, kind: 'execute', cycle: 1 })).toEqual({ next: 'stop' });

    expect(runs).toBe(1);
    expect((await c.sandboxes.list())[0]).toMatchObject({ taskId: task.id, running: false });
    expect((await c.steps.list(task.id)).some(s => s.payload.type === 'tool_result')).toBe(false);
  });

  test('the sandbox of a deleted task is destroyed', async () => {
    const c = setupAgent(env);
    const task = await planned(c);
    await c.sandboxes.create(task.id);
    await c.tasks.transition(task.id, 'cancelled');
    await c.tasks.delete(task.id);
    expect((await c.sweeper.sweep()).destroyed).toBe(1);
    expect(await c.sandboxes.list()).toEqual([]);
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
    c.clock.advance(RETENTION_MS);
    const r = await c.sweeper.sweep();
    expect(r).toMatchObject({ destroyed: 2, failed: 1 });
    expect((await c.sandboxes.list()).map(s => s.taskId)).toEqual([a.id]);
    expect(c.logger.entries).toMatchObject([
      { level: 'warn', fields: { sandboxId: `agent-sbx-${a.id}`, taskId: a.id, error: 'docker is gone' } },
    ]);
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

  test('an answer committed after the task was picked is seen inside the transition: rolled back, no finalize', async () => {
    const c = setupAgent({ ...env, WAIT_USER_TIMEOUT_MS: '60000' });
    const answered = await planned(c);
    const silent = await planned(c);
    await c.guard.pause(answered, 'execute');
    await c.guard.pause(silent, 'execute');
    c.clock.advance(61_000);
    // Ответ пришёл на границе тайм-аута: задача уже выбрана сборщиком, но переход ещё не начат.
    const findStale = c.tasks.findStale.bind(c.tasks);
    let answeredOnce = false;
    c.tasks.findStale = async query => {
      const found = await findStale(query);
      if (!answeredOnce && query.staleForMs === 60_000) {
        answeredOnce = true;
        await c.steps.append({
          taskId: answered.id,
          agent: 'user',
          payload: { type: 'message', role: 'user', text: 'EU' },
        });
      }
      return found;
    };
    const before = await c.tasks.get(answered.id);

    const r = await c.sweeper.sweep();
    expect(r).toMatchObject({ timedOut: 1, failed: 0 });
    // Переход откатился целиком: статус, partial и stopReason как были, из новых шагов — только ответ.
    expect(await c.tasks.get(answered.id)).toMatchObject({
      status: 'waiting_user',
      partial: before!.partial,
      stopReason: before!.stopReason,
      lastSeq: before!.lastSeq + 1,
    });
    const steps = await c.steps.list(answered.id);
    expect(steps.some(st => st.payload.type === 'status' && st.payload.to === 'finalizing')).toBe(false);
    expect(await c.tasks.get(silent.id)).toMatchObject({ status: 'finalizing', stopReason: 'wait_timeout' });
    expect(c.queue.jobs.map(j => [j.taskId, j.kind])).toEqual([[silent.id, 'finalize']]);
  });

  test('a timed-out task keeps its status step, partial and stopReason, and the finalize job is keyed after them', async () => {
    const c = setupAgent({ ...env, WAIT_USER_TIMEOUT_MS: '60000' });
    const task = await planned(c);
    await c.guard.pause(task, 'execute');
    c.clock.advance(61_000);
    await c.sweeper.sweep();
    const after = await c.tasks.get(task.id);
    expect(after).toMatchObject({ status: 'finalizing', partial: true, stopReason: 'wait_timeout' });
    expect(c.queue.jobs).toEqual([
      { taskId: task.id, kind: 'finalize', cycle: 1, key: jobKey(task.id, 'finalize', after!.lastSeq) },
    ]);
    const steps = await c.steps.list(task.id);
    expect(steps.at(-1)?.payload).toEqual({
      type: 'status',
      from: 'waiting_user',
      to: 'finalizing',
      reason: 'wait_timeout',
    });
  });

  test('a task resumed right before the transition stays running; the others are still timed out', async () => {
    const c = setupAgent({ ...env, WAIT_USER_TIMEOUT_MS: '60000' });
    const resumed = await planned(c);
    const silent = await planned(c);
    await c.tasks.transition(resumed.id, 'waiting_user', { currentKind: 'execute' });
    await c.tasks.transition(silent.id, 'waiting_user', { currentKind: 'execute' });
    c.clock.advance(61_000);
    // Job возобновил первую задачу уже после выборки, прямо перед переходом в finalizing.
    const findStale = c.tasks.findStale.bind(c.tasks);
    c.tasks.findStale = async query => {
      const found = await findStale(query);
      if (query.statuses.includes('waiting_user') && found.some(t => t.id === resumed.id))
        await c.tasks.transition(resumed.id, 'running', { currentKind: 'execute' });
      return found;
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
    expect(c.logger.entries).toMatchObject([{ level: 'warn', fields: { taskId: a.id, error: 'valkey is gone' } }]);
  });
});

/** Входной файл, объявленный через POST /api/uploads. */
const upload = (userId: string) => ({
  userId,
  kind: 'input' as const,
  path: 'data.csv',
  storageKey: `inputs/${userId}/${crypto.randomUUID()}/data.csv`,
  size: 4,
  mime: 'text/csv',
});

/** Сборщик держит файл (удаляет объект), а пользователь в это время создаёт задачу с ним. */
async function racingIntake(s3: 'ok' | 'down') {
  const c = setupAgent({ ...env, UPLOAD_TTL_MS: '3600000' });
  const userId = c.memory.seedUser();
  const file = await c.files.insert(upload(userId));
  await c.fileStore.put(file.storageKey, 'a\n1\n');
  c.clock.advance(3_600_001);
  let deleting!: () => void;
  const isDeleting = new Promise<void>(resolve => (deleting = resolve));
  let release!: () => void;
  const released = new Promise<void>(resolve => (release = resolve));
  const del = c.fileStore.delete.bind(c.fileStore);
  c.fileStore.delete = async key => {
    deleting();
    await released;
    if (s3 === 'down') throw new Error('s3 is down');
    await del(key);
  };
  const sweep = c.sweeper.sweep();
  await isDeleting;
  const intake = c.intake.create({ userId, prompt: 'use the file', fileIds: [file.id] });
  release();
  const [swept, created] = await Promise.allSettled([sweep, intake]);
  return { c, userId, file, swept, created };
}

describe('Sweeper: stale uploads', () => {
  test('an upload never attached to a task is removed after UPLOAD_TTL_MS: the record and the S3 object', async () => {
    const c = setupAgent({ ...env, UPLOAD_TTL_MS: '3600000' });
    const userId = c.memory.seedUser();
    const stale = await c.files.insert(upload(userId));
    await c.fileStore.put(stale.storageKey, 'a\n1\n');
    const task = await c.tasks.create({ userId, prompt: 'x' });
    const used = await c.files.insert(upload(userId));
    await c.fileStore.put(used.storageKey, 'b\n2\n');
    await c.files.attachToTask([used.id], userId, task.id);
    c.clock.advance(3_600_001);
    const fresh = await c.files.insert(upload(userId));
    await c.fileStore.put(fresh.storageKey, 'c\n3\n');

    const r = await c.sweeper.sweep();
    expect(r).toMatchObject({ uploads: 1, failed: 0 });
    expect(await c.files.get(stale.id)).toBeUndefined();
    expect(await c.fileStore.exists(stale.storageKey)).toBe(false);
    for (const kept of [used, fresh]) {
      expect(await c.files.get(kept.id)).toBeDefined();
      expect(await c.fileStore.exists(kept.storageKey)).toBe(true);
    }
  });

  test('an old output file of a task is never removed', async () => {
    const c = setupAgent({ ...env, UPLOAD_TTL_MS: '3600000' });
    const userId = c.memory.seedUser();
    const task = await c.tasks.create({ userId, prompt: 'x' });
    await c.tasks.transition(task.id, 'cancelled');
    const output = await c.files.insert({
      ...upload(userId),
      taskId: task.id,
      kind: 'output',
      path: 'outputs/r.csv',
      storageKey: `tasks/${task.id}/outputs/r.csv`,
    });
    await c.fileStore.put(output.storageKey, 'r\n');
    c.clock.advance(10 * 3_600_000);

    const r = await c.sweeper.sweep();
    expect(r.uploads).toBe(0);
    expect(await c.files.get(output.id)).toBeDefined();
    expect(await c.fileStore.exists(output.storageKey)).toBe(true);
  });

  test('an upload attached between the listing and the delete keeps its record and object', async () => {
    const c = setupAgent({ ...env, UPLOAD_TTL_MS: '3600000' });
    const userId = c.memory.seedUser();
    const file = await c.files.insert(upload(userId));
    await c.fileStore.put(file.storageKey, 'a\n1\n');
    const task = await c.tasks.create({ userId, prompt: 'x' });
    c.clock.advance(3_600_001);
    // Пользователь создал задачу с этим файлом, пока сборщик держал выборку.
    const list = c.files.listUnattachedInputs.bind(c.files);
    c.files.listUnattachedInputs = async opts => {
      const found = await list(opts);
      await c.files.attachToTask([file.id], userId, task.id);
      return found;
    };
    const r = await c.sweeper.sweep();
    expect(r.uploads).toBe(0);
    expect((await c.files.get(file.id))?.taskId).toBe(task.id);
    expect(await c.fileStore.exists(file.storageKey)).toBe(true);
  });

  test('a stale upload whose S3 object is already gone is removed without a failure', async () => {
    const c = setupAgent({ ...env, UPLOAD_TTL_MS: '3600000' });
    const userId = c.memory.seedUser();
    const file = await c.files.insert(upload(userId));
    c.clock.advance(3_600_001);
    const r = await c.sweeper.sweep();
    expect(r).toMatchObject({ uploads: 1, failed: 0 });
    expect(await c.files.get(file.id)).toBeUndefined();
    expect(c.logger.entries).toEqual([]);
  });

  test('a failing S3 delete is counted and logged; the record stays and the next pass removes both', async () => {
    const c = setupAgent({ ...env, UPLOAD_TTL_MS: '3600000' });
    const userId = c.memory.seedUser();
    const file = await c.files.insert(upload(userId));
    await c.fileStore.put(file.storageKey, 'a\n1\n');
    c.clock.advance(3_600_001);
    const del = c.fileStore.delete.bind(c.fileStore);
    c.fileStore.delete = () => Promise.reject(new Error('s3 is down'));
    const r = await c.sweeper.sweep();
    expect(r).toMatchObject({ uploads: 0, failed: 1 });
    expect(await c.files.get(file.id)).toBeDefined();
    expect(c.logger.entries).toMatchObject([
      { level: 'warn', fields: { fileId: file.id, storageKey: file.storageKey, error: 's3 is down' } },
    ]);

    c.fileStore.delete = del;
    expect(await c.sweeper.sweep()).toMatchObject({ uploads: 1, failed: 0 });
    expect(await c.files.get(file.id)).toBeUndefined();
    expect(await c.fileStore.exists(file.storageKey)).toBe(false);
  });

  test('a task created with an upload the sweeper is removing is refused: the sweep wins', async () => {
    const { c, userId, file, swept, created } = await racingIntake('ok');
    expect(swept).toMatchObject({ status: 'fulfilled', value: { uploads: 1, failed: 0 } });
    expect(created.status).toBe('rejected');
    expect(await c.tasks.countActive(userId)).toBe(0);
    expect(await c.files.get(file.id)).toBeUndefined();
    expect(await c.fileStore.exists(file.storageKey)).toBe(false);
  });

  test('when the S3 delete fails while a task is created with the upload, the task gets the file', async () => {
    const { c, file, swept, created } = await racingIntake('down');
    expect(swept).toMatchObject({ status: 'fulfilled', value: { uploads: 0, failed: 1 } });
    expect(created.status).toBe('fulfilled');
    const task = created.status === 'fulfilled' ? created.value : undefined;
    expect((await c.files.get(file.id))?.taskId).toBe(task?.id);
    expect(await c.fileStore.exists(file.storageKey)).toBe(true);
  });
});
