import { describe, expect, test } from 'bun:test';
import { ApiErrorSchema, FileListResponseSchema } from '@agent/shared';
import { setupApi, type ApiTest } from './helpers';

const output = async (t: ApiTest, userId: string, taskId: string, path: string, mime: string) => {
  const file = await t.c.files.insert({
    userId,
    taskId,
    kind: 'output',
    path,
    storageKey: `tasks/${taskId}/${path}`,
    size: 10,
    mime,
  });
  await t.c.fileStore.put(file.storageKey, 'x');
  t.c.clock.advance(1000);
  return file;
};

const list = async (t: ApiTest, headers: Record<string, string>, query = '') =>
  FileListResponseSchema.parse(await (await t.call('GET', `/api/files${query}`, { headers })).json());

describe('GET /api/files', () => {
  test('lists own outputs newest first with their task, page by page through nextCursor', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const other = await t.signIn();
    const task = await t.c.intake.create({ userId: user.id, prompt: 'x' });
    const foreign = await t.c.intake.create({ userId: other.user.id, prompt: 'y' });
    await output(t, other.user.id, foreign.id, 'outputs/theirs.md', 'text/markdown');
    const ids: string[] = [];
    for (const name of ['a', 'b', 'c'])
      ids.unshift((await output(t, user.id, task.id, `outputs/${name}.md`, 'text/markdown')).id);
    // Входной файл в Library не попадает.
    await t.c.files.insert({
      userId: user.id,
      kind: 'input',
      path: 'in.csv',
      storageKey: 'in/k',
      size: 1,
      mime: 'text/csv',
    });

    const first = await list(t, headers, '?limit=2');
    expect(first.files.map(f => f.id)).toEqual(ids.slice(0, 2));
    expect(first.files[0]).toMatchObject({ taskId: task.id, kind: 'output', path: 'outputs/c.md' });
    const second = await list(t, headers, `?limit=2&before=${encodeURIComponent(first.nextCursor!)}`);
    expect(second.files.map(f => f.id)).toEqual(ids.slice(2));
    expect(second.nextCursor).toBeNull();
  });

  test('filters by category and by a case-insensitive part of the path', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const task = await t.c.intake.create({ userId: user.id, prompt: 'x' });
    const png = await output(t, user.id, task.id, 'outputs/chart.png', 'image/png');
    const csv = await output(t, user.id, task.id, 'outputs/Sales.csv', 'text/csv');
    const md = await output(t, user.id, task.id, 'outputs/notes.md', 'text/markdown');
    await output(t, user.id, task.id, 'outputs/data.zip', 'application/zip');
    const ids = async (query: string) => (await list(t, headers, query)).files.map(f => f.id);
    expect(await ids('?category=images')).toEqual([png.id]);
    expect(await ids('?category=spreadsheets')).toEqual([csv.id]);
    expect(await ids('?category=documents')).toEqual([md.id]);
    expect(await ids('?q=SALES')).toEqual([csv.id]);
    expect(await ids('?category=images&q=sales')).toEqual([]);
    expect(await list(t, headers)).toMatchObject({ nextCursor: null });
    expect((await list(t, headers)).files).toHaveLength(4);
  });

  test('an unknown category or a bad cursor is 400; a session is required', async () => {
    const t = setupApi();
    const { headers } = await t.signIn();
    for (const query of ['?category=other', '?before=nope', '?limit=0']) {
      const res = await t.call('GET', `/api/files${query}`, { headers });
      expect(res.status).toBe(400);
      expect(ApiErrorSchema.parse(await res.json()).error.code).toBe('bad_request');
    }
    expect((await t.call('GET', '/api/files')).status).toBe(401);
  });
});

describe('DELETE /api/files/:id', () => {
  test('the owner deletes an output: the object and the row are gone, the task stays', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const task = await t.c.intake.create({ userId: user.id, prompt: 'x' });
    const file = await output(t, user.id, task.id, 'outputs/a.md', 'text/markdown');
    const res = await t.call('DELETE', `/api/files/${file.id}`, { headers });
    expect(res.status).toBe(204);
    expect(await t.c.files.get(file.id)).toBeUndefined();
    expect(await t.c.fileStore.exists(file.storageKey)).toBe(false);
    expect(await t.c.tasks.get(task.id)).toBeDefined();
  });

  test("another user's file, an unknown id and a malformed id are 404; an input file is 409", async () => {
    const t = setupApi();
    const owner = await t.signIn();
    const { user, headers } = await t.signIn();
    const task = await t.c.intake.create({ userId: owner.user.id, prompt: 'x' });
    const theirs = await output(t, owner.user.id, task.id, 'outputs/a.md', 'text/markdown');
    for (const id of [theirs.id, crypto.randomUUID(), 'abc'])
      expect((await t.call('DELETE', `/api/files/${id}`, { headers })).status).toBe(404);
    expect(await t.c.fileStore.exists(theirs.storageKey)).toBe(true);
    const input = await t.c.files.insert({
      userId: user.id,
      kind: 'input',
      path: 'in.csv',
      storageKey: 'in/k',
      size: 1,
      mime: 'text/csv',
    });
    const res = await t.call('DELETE', `/api/files/${input.id}`, { headers });
    expect(res.status).toBe(409);
    expect(ApiErrorSchema.parse(await res.json()).error.code).toBe('conflict');
    expect(await t.c.files.get(input.id)).toBeDefined();
  });

  test('needs a session and the Origin of the app', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const task = await t.c.intake.create({ userId: user.id, prompt: 'x' });
    const file = await output(t, user.id, task.id, 'outputs/a.md', 'text/markdown');
    expect((await t.call('DELETE', `/api/files/${file.id}`)).status).toBe(401);
    const noOrigin = await t.app.request(`/api/files/${file.id}`, {
      method: 'DELETE',
      headers: { cookie: headers.cookie },
    });
    expect(noOrigin.status).toBe(403);
    expect(await t.c.files.get(file.id)).toBeDefined();
    expect(await t.c.fileStore.exists(file.storageKey)).toBe(true);
  });

  test('a storage failure is 500 and keeps the row; a retry finishes', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const task = await t.c.intake.create({ userId: user.id, prompt: 'x' });
    const file = await output(t, user.id, task.id, 'outputs/a.md', 'text/markdown');
    const del = t.c.fileStore.delete.bind(t.c.fileStore);
    t.c.fileStore.delete = () => Promise.reject(new Error('s3 is down'));
    expect((await t.call('DELETE', `/api/files/${file.id}`, { headers })).status).toBe(500);
    expect(await t.c.files.get(file.id)).toBeDefined();
    t.c.fileStore.delete = del;
    expect((await t.call('DELETE', `/api/files/${file.id}`, { headers })).status).toBe(204);
  });
});
