import { describe, expect, test } from 'bun:test';
import { ApiErrorSchema } from '@agent/shared';
import { setupApi, type ApiTest } from './helpers';

/** Отменённая задача с результатом в хранилище и списанием. */
async function finishedTask(t: ApiTest, userId: string) {
  const task = await t.c.intake.create({ userId, prompt: 'Report' });
  await t.c.tasks.transition(task.id, 'cancelled');
  const file = await t.c.files.insert({
    userId,
    taskId: task.id,
    kind: 'output',
    path: 'outputs/r.md',
    storageKey: `tasks/${task.id}/outputs/r.md`,
    size: 1,
    mime: 'text/markdown',
  });
  await t.c.fileStore.put(file.storageKey, 'x');
  await t.c.ledger.record({ userId, taskId: task.id, model: 'q', tokensIn: 1, tokensOut: 1, millicredits: 5 });
  return { task, file };
}

describe('DELETE /api/tasks/:id', () => {
  test('the owner deletes a finished task: its objects and rows are gone, the usage event stays', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const { task, file } = await finishedTask(t, user.id);
    const res = await t.call('DELETE', `/api/tasks/${task.id}`, { headers });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(await t.c.tasks.get(task.id)).toBeUndefined();
    expect(await t.c.files.get(file.id)).toBeUndefined();
    expect(await t.c.fileStore.exists(file.storageKey)).toBe(false);
    expect(t.c.memory.usage.map(e => e.taskId)).toEqual([null]);
    expect((await t.call('GET', `/api/tasks/${task.id}`, { headers })).status).toBe(404);
  });

  test('an active task is 409 saying to stop it first; nothing is deleted', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const task = await t.c.intake.create({ userId: user.id, prompt: 'Running' });
    const res = await t.call('DELETE', `/api/tasks/${task.id}`, { headers });
    expect(res.status).toBe(409);
    const { error } = ApiErrorSchema.parse(await res.json());
    expect(error.code).toBe('conflict');
    expect(error.message).toContain('stop it first');
    expect(await t.c.tasks.get(task.id)).toBeDefined();
  });

  test("another user's task, an unknown id and a malformed id are 404", async () => {
    const t = setupApi();
    const owner = await t.signIn();
    const { headers } = await t.signIn();
    const { task, file } = await finishedTask(t, owner.user.id);
    for (const id of [task.id, crypto.randomUUID(), 'abc'])
      expect((await t.call('DELETE', `/api/tasks/${id}`, { headers })).status).toBe(404);
    expect(await t.c.fileStore.exists(file.storageKey)).toBe(true);
  });

  test('a storage failure is 500 and keeps the task; a retry finishes', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const { task } = await finishedTask(t, user.id);
    const del = t.c.fileStore.delete.bind(t.c.fileStore);
    t.c.fileStore.delete = () => Promise.reject(new Error('s3 is down'));
    expect((await t.call('DELETE', `/api/tasks/${task.id}`, { headers })).status).toBe(500);
    expect(await t.c.tasks.get(task.id)).toBeDefined();
    t.c.fileStore.delete = del;
    expect((await t.call('DELETE', `/api/tasks/${task.id}`, { headers })).status).toBe(204);
  });

  test('needs a session and the Origin of the app', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const { task } = await finishedTask(t, user.id);
    expect((await t.call('DELETE', `/api/tasks/${task.id}`)).status).toBe(401);
    const noOrigin = await t.app.request(`/api/tasks/${task.id}`, {
      method: 'DELETE',
      headers: { cookie: headers.cookie },
    });
    expect(noOrigin.status).toBe(403);
    expect(await t.c.tasks.get(task.id)).toBeDefined();
  });
});
