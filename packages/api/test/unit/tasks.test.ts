import { describe, expect, test } from 'bun:test';
import { ApiErrorSchema, TaskEnvelopeSchema, TaskListResponseSchema, TaskResponseSchema } from '@agent/shared';
import { setupApi, type ApiTest } from './helpers';

async function uploaded(t: ApiTest, userId: string, name = 'data.csv') {
  const storageKey = `inputs/${userId}/${crypto.randomUUID()}/${name}`;
  await t.c.fileStore.put(storageKey, 'a,b\n1,2\n', 'text/csv');
  return t.c.files.insert({ userId, kind: 'input', path: name, storageKey, size: 8, mime: 'text/csv' });
}

const errorCode = async (res: Response) => ApiErrorSchema.parse(await res.json()).error.code;

describe('POST /api/tasks', () => {
  test('creates a queued task and queues its plan job', async () => {
    const t = setupApi();
    const { headers } = await t.signIn();
    const res = await t.call('POST', '/api/tasks', { headers, body: { prompt: 'Compare three CRMs' } });
    expect(res.status).toBe(201);
    const { task } = TaskEnvelopeSchema.parse(await res.json());
    expect(task).toMatchObject({ prompt: 'Compare three CRMs', status: 'queued', partial: false, lastSeq: 1 });
    expect(t.c.queue.jobs).toEqual([{ taskId: task.id, kind: 'plan', key: `${task.id}.plan.1` }]);
  });

  test('attaches own uploaded files', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const file = await uploaded(t, user.id);
    const res = await t.call('POST', '/api/tasks', {
      headers,
      body: { prompt: 'Sum it', fileIds: [file.id, file.id] },
    });
    expect(res.status).toBe(201);
    const { task } = TaskEnvelopeSchema.parse(await res.json());
    expect((await t.c.files.listForTask(task.id)).map(f => f.id)).toEqual([file.id]);
  });

  test('a foreign file is 404 and creates nothing', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const other = await t.signIn();
    const foreign = await uploaded(t, other.user.id);
    const res = await t.call('POST', '/api/tasks', { headers, body: { prompt: 'x', fileIds: [foreign.id] } });
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('not_found');
    expect(await t.c.tasks.listForUser(user.id)).toEqual([]);
  });

  test('a file whose upload never reached storage is 409 upload_incomplete', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const pending = await t.c.files.insert({
      userId: user.id,
      kind: 'input',
      path: 'big.csv',
      storageKey: `inputs/${user.id}/${crypto.randomUUID()}/big.csv`,
      size: 10,
      mime: 'text/csv',
    });
    const res = await t.call('POST', '/api/tasks', { headers, body: { prompt: 'x', fileIds: [pending.id] } });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('upload_incomplete');
  });

  test('limits: no credits is 402, too many active tasks is 429', async () => {
    const t = setupApi({ MAX_ACTIVE_TASKS_PER_USER: '1' });
    const broke = await t.signIn({ millicredits: 0 });
    const r402 = await t.call('POST', '/api/tasks', { headers: broke.headers, body: { prompt: 'x' } });
    expect(r402.status).toBe(402);
    expect(await errorCode(r402)).toBe('insufficient_credits');
    const { headers } = await t.signIn();
    expect((await t.call('POST', '/api/tasks', { headers, body: { prompt: 'first' } })).status).toBe(201);
    const r429 = await t.call('POST', '/api/tasks', { headers, body: { prompt: 'second' } });
    expect(r429.status).toBe(429);
    expect(await errorCode(r429)).toBe('too_many_active_tasks');
  });

  test('an invalid body is 400 bad_request', async () => {
    const t = setupApi();
    const { headers } = await t.signIn();
    for (const body of [{ prompt: '' }, { prompt: 'x', fileIds: ['not-a-uuid'] }, { nope: 1 }]) {
      const res = await t.call('POST', '/api/tasks', { headers, body });
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe('bad_request');
    }
    const notJson = await t.app.request('/api/tasks', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(notJson.status).toBe(400);
  });
});

describe('GET /api/tasks', () => {
  test('lists own tasks newest first, page by page through nextCursor', async () => {
    const t = setupApi({ MAX_ACTIVE_TASKS_PER_USER: '10' });
    const { user, headers } = await t.signIn();
    const other = await t.signIn();
    await t.c.intake.create({ userId: other.user.id, prompt: 'not mine' });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.unshift((await t.c.intake.create({ userId: user.id, prompt: `t${i}` })).id);
      if (i % 2 === 0) t.c.clock.advance(1000); // часть задач — в одну миллисекунду
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const query: string = cursor ? `?limit=2&before=${cursor}` : '?limit=2';
      const res = await t.call('GET', `/api/tasks${query}`, { headers });
      expect(res.status).toBe(200);
      const body = TaskListResponseSchema.parse(await res.json());
      seen.push(...body.tasks.map(x => x.id));
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(ids);
  });

  test('a malformed cursor or limit is 400', async () => {
    const t = setupApi();
    const { headers } = await t.signIn();
    for (const query of ['?before=garbage', '?limit=0', '?limit=101', `?before=${btoa('{"t":"x","id":"y"}')}`]) {
      const res = await t.call('GET', `/api/tasks${query}`, { headers });
      expect(res.status).toBe(400);
    }
  });
});

describe('GET /api/tasks/:id', () => {
  test('returns the task with its subtasks and files', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const file = await uploaded(t, user.id);
    const task = await t.c.intake.create({ userId: user.id, prompt: 'Sum it', fileIds: [file.id] });
    await t.c.subtasks.insertMany(task.id, [{ goal: 'sum', context: '', doneCriteria: 'summed', expectedOutputs: [] }]);
    const res = await t.call('GET', `/api/tasks/${task.id}`, { headers });
    expect(res.status).toBe(200);
    const body = TaskResponseSchema.parse(await res.json());
    expect(body.task.id).toBe(task.id);
    expect(body.subtasks.map(s => [s.idx, s.goal, s.status])).toEqual([[0, 'sum', 'pending']]);
    expect(body.files).toEqual([
      expect.objectContaining({ id: file.id, kind: 'input', path: 'data.csv', url: `/api/files/${file.id}` }),
    ]);
  });

  test("another user's task, an unknown id and a malformed id are all 404", async () => {
    const t = setupApi();
    const owner = await t.signIn();
    const { headers } = await t.signIn();
    const task = await t.c.intake.create({ userId: owner.user.id, prompt: 'private' });
    for (const id of [task.id, crypto.randomUUID(), 'abc']) {
      const res = await t.call('GET', `/api/tasks/${id}`, { headers });
      expect(res.status).toBe(404);
      expect(await errorCode(res)).toBe('not_found');
    }
  });
});

describe('hardening', () => {
  test('foreign, unknown and malformed task ids give byte-identical 404 bodies', async () => {
    const t = setupApi();
    const owner = await t.signIn();
    const { headers } = await t.signIn();
    const task = await t.c.intake.create({ userId: owner.user.id, prompt: 'private' });
    const bodies = new Set<string>();
    for (const id of [task.id, crypto.randomUUID(), 'abc', '%00', 'x'.repeat(300)]) {
      const res = await t.call('GET', `/api/tasks/${id}`, { headers });
      expect(res.status).toBe(404);
      bodies.add(await res.text());
    }
    expect(bodies.size).toBe(1);
  });

  test('the task responses do not leak the owner, the sandbox or storage keys', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const file = await uploaded(t, user.id);
    const task = await t.c.intake.create({ userId: user.id, prompt: 'Sum it', fileIds: [file.id] });
    const text = await (await t.call('GET', `/api/tasks/${task.id}`, { headers })).text();
    expect(text).not.toContain(user.id);
    expect(text).not.toContain('storageKey');
    expect(text).not.toContain(file.storageKey);
    expect(text).not.toContain('sandboxId');
  });

  test('an output file or an already attached file cannot be attached again', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const storageKey = `outputs/${user.id}/${crypto.randomUUID()}/o.csv`;
    await t.c.fileStore.put(storageKey, 'x', 'text/csv');
    const output = await t.c.files.insert({
      userId: user.id,
      kind: 'output',
      path: 'o.csv',
      storageKey,
      size: 1,
      mime: 'text/csv',
    });
    const r1 = await t.call('POST', '/api/tasks', { headers, body: { prompt: 'x', fileIds: [output.id] } });
    expect(r1.status).toBe(404);
    const file = await uploaded(t, user.id);
    expect((await t.call('POST', '/api/tasks', { headers, body: { prompt: 'a', fileIds: [file.id] } })).status).toBe(
      201,
    );
    const r2 = await t.call('POST', '/api/tasks', { headers, body: { prompt: 'b', fileIds: [file.id] } });
    expect(r2.status).toBe(404);
  });

  test('the default page size is 20 and a full last page has no nextCursor', async () => {
    const t = setupApi({ MAX_ACTIVE_TASKS_PER_USER: '100' });
    const { user, headers } = await t.signIn();
    for (let i = 0; i < 20; i++) await t.c.intake.create({ userId: user.id, prompt: `t${i}` });
    const body = TaskListResponseSchema.parse(await (await t.call('GET', '/api/tasks', { headers })).json());
    expect(body.tasks).toHaveLength(20);
    expect(body.nextCursor).toBeNull();
  });

  test('every task route requires a session', async () => {
    const t = setupApi();
    for (const [method, path] of [
      ['POST', '/api/tasks'],
      ['GET', '/api/tasks'],
      ['GET', `/api/tasks/${crypto.randomUUID()}`],
    ] as const) {
      expect((await t.call(method, path)).status).toBe(401);
    }
  });
});
