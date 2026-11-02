import { expect, test } from 'bun:test';
import { NotFoundError } from '@agent/core';
import { createTestContainer } from '@agent/testing';
import { DELETE_USER_USAGE, deleteUserData, UsageError } from '../../src';

function setup() {
  const c = createTestContainer().cradle;
  const deleted: string[] = [];
  const auth = {
    findUserId: async (email: string) => [...c.memory.users.values()].find(u => u.email === email)?.id,
    deleteUser: async (id: string) => void deleted.push(id),
  };
  return { c, deleted, deps: { auth, files: c.files, fileStore: c.fileStore, tasks: c.tasks } };
}

const upload = (userId: string, name = 'a.csv') => ({
  userId,
  kind: 'input' as const,
  path: name,
  storageKey: `inputs/${userId}/${crypto.randomUUID()}/${name}`,
  size: 1,
  mime: 'text/csv',
});

/** Пользователь ann@test.dev с отменённой задачей, входным файлом и результатом; bob@test.dev с одним файлом. */
async function seedTwoUsers(c: ReturnType<typeof setup>['c']) {
  const me = c.memory.seedUser({ email: 'ann@test.dev' });
  const other = c.memory.seedUser({ email: 'bob@test.dev' });
  const task = await c.tasks.create({ userId: me, prompt: 'x' });
  await c.tasks.transition(task.id, 'cancelled');
  const mine = [
    await c.files.insert(upload(me)),
    await c.files.insert({ ...upload(me, 'r.md'), taskId: task.id, kind: 'output', path: 'outputs/r.md' }),
  ];
  const theirs = await c.files.insert(upload(other));
  for (const f of [...mine, theirs]) await c.fileStore.put(f.storageKey, 'x');
  return { me, mine, theirs };
}

test('without --yes only what would be deleted is printed: nothing is deleted', async () => {
  const { c, deleted, deps } = setup();
  const { me, mine } = await seedTwoUsers(c);
  const out = await deleteUserData(deps, ['Ann@Test.dev']);
  expect(out).toContain(`would delete ann@test.dev (user ${me}): 2 file(s)`);
  expect(out).toContain('--yes');
  for (const f of mine) expect(out).toContain(f.storageKey);
  for (const f of mine) expect(await c.fileStore.exists(f.storageKey)).toBe(true);
  expect(deleted).toEqual([]);
});

test('with --yes: deletes the S3 objects of every file of the user, then the user; another user is kept', async () => {
  const { c, deleted, deps } = setup();
  const { me, mine, theirs } = await seedTwoUsers(c);

  expect(await deleteUserData(deps, ['Ann@Test.dev', '--yes'])).toBe('deleted ann@test.dev: 2 file(s)');
  for (const f of mine) expect(await c.fileStore.exists(f.storageKey)).toBe(false);
  expect(await c.fileStore.exists(theirs.storageKey)).toBe(true);
  expect(deleted).toEqual([me]);
});

test('an S3 object that is already gone does not stop the deletion', async () => {
  const { c, deleted, deps } = setup();
  const me = c.memory.seedUser({ email: 'ann@test.dev' });
  await c.files.insert(upload(me));
  expect(await deleteUserData(deps, ['--yes', 'ann@test.dev'])).toBe('deleted ann@test.dev: 1 file(s)');
  expect(deleted).toEqual([me]);
});

test('a user with an active task is refused and nothing is deleted', async () => {
  const { c, deleted, deps } = setup();
  const me = c.memory.seedUser({ email: 'ann@test.dev' });
  await c.tasks.create({ userId: me, prompt: 'x' });
  const file = await c.files.insert(upload(me));
  await c.fileStore.put(file.storageKey, 'x');
  for (const args of [['ann@test.dev'], ['ann@test.dev', '--yes']])
    await expect(deleteUserData(deps, args)).rejects.toThrow('ann@test.dev has 1 active task(s)');
  expect(await c.fileStore.exists(file.storageKey)).toBe(true);
  expect(deleted).toEqual([]);
});

test('a failing S3 delete stops before the user is deleted: a rerun can finish the job', async () => {
  const { c, deleted, deps } = setup();
  const me = c.memory.seedUser({ email: 'ann@test.dev' });
  await c.files.insert(upload(me));
  const del = c.fileStore.delete.bind(c.fileStore);
  c.fileStore.delete = () => Promise.reject(new Error('s3 is down'));
  await expect(deleteUserData(deps, ['ann@test.dev', '--yes'])).rejects.toThrow('s3 is down');
  expect(deleted).toEqual([]);
  c.fileStore.delete = del;
  expect(await deleteUserData(deps, ['ann@test.dev', '--yes'])).toBe('deleted ann@test.dev: 1 file(s)');
  expect(deleted).toEqual([me]);
});

test('an unknown email is NotFoundError; a missing, extra or unknown argument is the usage', async () => {
  const { c, deleted, deps } = setup();
  c.memory.seedUser({ email: 'ann@test.dev' });
  await expect(deleteUserData(deps, ['nobody@test.dev', '--yes'])).rejects.toBeInstanceOf(NotFoundError);
  for (const args of [
    [],
    ['--yes'],
    ['ann@test.dev', 'extra'],
    ['ann@test.dev', '--force'],
    ['ann@test.dev', '--yes', '--yes'],
  ]) {
    const p = deleteUserData(deps, args);
    await expect(p).rejects.toBeInstanceOf(UsageError);
    await expect(p).rejects.toThrow(DELETE_USER_USAGE);
  }
  expect(deleted).toEqual([]);
});
