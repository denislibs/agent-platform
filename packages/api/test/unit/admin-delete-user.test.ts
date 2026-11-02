import { expect, test } from 'bun:test';
import { NotFoundError } from '@agent/core';
import { createTestContainer } from '@agent/testing';
import { DELETE_USER_USAGE, deleteUserData, UsageError } from '../../src';

const IDLE_MS = 10 * 60_000;

function setup() {
  const c = createTestContainer().cradle;
  /** Порядок действий: отзыв сессий, удаление объектов S3, удаление пользователя. */
  const calls: string[] = [];
  const auth = {
    findUserId: async (email: string) => [...c.memory.users.values()].find(u => u.email === email)?.id,
    deleteSessions: async (id: string) => void calls.push(`sessions ${id}`),
    deleteUser: async (id: string) => void calls.push(`user ${id}`),
  };
  const del = c.fileStore.delete.bind(c.fileStore);
  c.fileStore.delete = async key => {
    calls.push(`object ${key}`);
    await del(key);
  };
  const deps = { auth, files: c.files, fileStore: c.fileStore, tasks: c.tasks, sandboxes: c.sandboxes, clock: c.clock };
  return { c, calls, deps, deletedUsers: () => calls.filter(x => x.startsWith('user ')) };
}

const upload = (userId: string, name = 'a.csv') => ({
  userId,
  kind: 'input' as const,
  path: name,
  storageKey: `inputs/${userId}/${crypto.randomUUID()}/${name}`,
  size: 1,
  mime: 'text/csv',
});

/** ann@test.dev с отменённой задачей, входным файлом и результатом; bob@test.dev с одним файлом. */
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
  return { me, task, mine, theirs };
}

test('without --yes only what would be deleted is printed: nothing is deleted, sessions are kept', async () => {
  const { c, calls, deps } = setup();
  const { me, mine, theirs } = await seedTwoUsers(c);
  c.clock.advance(IDLE_MS + 1);
  const out = await deleteUserData(deps, ['Ann@Test.dev']);
  expect(out).toContain(`would delete ann@test.dev (user ${me}): 2 file(s)`);
  expect(out).toContain('--yes');
  for (const f of mine) expect(out).toContain(f.storageKey);
  expect(out).not.toContain(theirs.storageKey);
  for (const f of mine) expect(await c.fileStore.exists(f.storageKey)).toBe(true);
  expect(calls).toEqual([]);
});

test('with --yes: sessions are revoked first, then the S3 objects of every file, then the user; another user is kept', async () => {
  const { c, calls, deps } = setup();
  const { me, mine, theirs } = await seedTwoUsers(c);
  c.clock.advance(IDLE_MS + 1);

  expect(await deleteUserData(deps, ['Ann@Test.dev', '--yes'])).toBe('deleted ann@test.dev: 2 file(s)');
  expect(calls).toEqual([`sessions ${me}`, ...mine.map(f => `object ${f.storageKey}`), `user ${me}`]);
  for (const f of mine) expect(await c.fileStore.exists(f.storageKey)).toBe(false);
  expect(await c.fileStore.exists(theirs.storageKey)).toBe(true);
});

test('an S3 object that is already gone does not stop the deletion', async () => {
  const { c, deps, deletedUsers } = setup();
  const me = c.memory.seedUser({ email: 'ann@test.dev' });
  await c.files.insert(upload(me));
  expect(await deleteUserData(deps, ['--yes', 'ann@test.dev'])).toBe('deleted ann@test.dev: 1 file(s)');
  expect(deletedUsers()).toEqual([`user ${me}`]);
});

test('a user with an active task is refused and nothing is deleted', async () => {
  const { c, deps, deletedUsers } = setup();
  const me = c.memory.seedUser({ email: 'ann@test.dev' });
  await c.tasks.create({ userId: me, prompt: 'x' });
  const file = await c.files.insert(upload(me));
  await c.fileStore.put(file.storageKey, 'x');
  c.clock.advance(IDLE_MS + 1);
  for (const args of [['ann@test.dev'], ['ann@test.dev', '--yes']])
    await expect(deleteUserData(deps, args)).rejects.toThrow('ann@test.dev has 1 active task(s)');
  expect(await c.fileStore.exists(file.storageKey)).toBe(true);
  expect(deletedUsers()).toEqual([]);
});

test('a task that finished less than --idle-minutes ago is refused: its finalizer may still upload', async () => {
  const { c, calls, deps, deletedUsers } = setup();
  const { me, mine } = await seedTwoUsers(c);
  c.clock.advance(IDLE_MS - 60_000);
  for (const args of [['ann@test.dev'], ['ann@test.dev', '--yes']])
    await expect(deleteUserData(deps, args)).rejects.toThrow(
      'ann@test.dev has task(s) that finished less than 10 minute(s) ago',
    );
  // Сессии отозваны до проверок (--yes): пока ждём, новых задач и загрузок не будет.
  expect(calls).toEqual([`sessions ${me}`]);
  for (const f of mine) expect(await c.fileStore.exists(f.storageKey)).toBe(true);

  expect(await deleteUserData(deps, ['ann@test.dev', '--yes', '--idle-minutes=5'])).toBe(
    'deleted ann@test.dev: 2 file(s)',
  );
  expect(deletedUsers()).toEqual([`user ${me}`]);
});

test('a sandbox of any task of the user is refused and nothing is deleted', async () => {
  const { c, deps, deletedUsers } = setup();
  const { task, mine } = await seedTwoUsers(c);
  await c.sandboxes.create(task.id);
  c.clock.advance(IDLE_MS + 1);
  for (const args of [['ann@test.dev'], ['ann@test.dev', '--yes']])
    await expect(deleteUserData(deps, args)).rejects.toThrow('ann@test.dev still has 1 sandbox(es)');
  for (const f of mine) expect(await c.fileStore.exists(f.storageKey)).toBe(true);
  expect(deletedUsers()).toEqual([]);
});

test('sandboxes of other users do not matter; a failing sandbox listing refuses', async () => {
  const { c, deps, deletedUsers } = setup();
  const { me } = await seedTwoUsers(c);
  const strangerTask = await c.tasks.create({ userId: c.memory.seedUser(), prompt: 'y' });
  await c.sandboxes.create(strangerTask.id);
  c.clock.advance(IDLE_MS + 1);
  const list = c.sandboxes.list.bind(c.sandboxes);
  c.sandboxes.list = () => Promise.reject(new Error('docker is not reachable'));
  await expect(deleteUserData(deps, ['ann@test.dev', '--yes'])).rejects.toThrow(
    'could not list sandboxes: docker is not reachable',
  );
  expect(deletedUsers()).toEqual([]);
  c.sandboxes.list = list;
  expect(await deleteUserData(deps, ['ann@test.dev', '--yes'])).toBe('deleted ann@test.dev: 2 file(s)');
  expect(deletedUsers()).toEqual([`user ${me}`]);
});

test('a file that appears while objects are deleted stops before the user is deleted: a rerun finishes', async () => {
  const { c, deps, deletedUsers } = setup();
  const me = c.memory.seedUser({ email: 'ann@test.dev' });
  await c.files.insert(upload(me));
  const del = c.fileStore.delete.bind(c.fileStore);
  let late = true;
  c.fileStore.delete = async key => {
    // Запрос, прошедший проверку сессии до её отзыва, успел объявить загрузку.
    if (late) await c.files.insert(upload(me, 'late.csv'));
    late = false;
    await del(key);
  };
  await expect(deleteUserData(deps, ['ann@test.dev', '--yes'])).rejects.toThrow(
    'ann@test.dev changed during the deletion',
  );
  expect(deletedUsers()).toEqual([]);
  expect(await deleteUserData(deps, ['ann@test.dev', '--yes'])).toBe('deleted ann@test.dev: 2 file(s)');
  expect(deletedUsers()).toEqual([`user ${me}`]);
});

test('a failing S3 delete stops before the user is deleted: a rerun can finish the job', async () => {
  const { c, deps, deletedUsers } = setup();
  const me = c.memory.seedUser({ email: 'ann@test.dev' });
  await c.files.insert(upload(me));
  const del = c.fileStore.delete.bind(c.fileStore);
  c.fileStore.delete = () => Promise.reject(new Error('s3 is down'));
  await expect(deleteUserData(deps, ['ann@test.dev', '--yes'])).rejects.toThrow('s3 is down');
  expect(deletedUsers()).toEqual([]);
  c.fileStore.delete = del;
  expect(await deleteUserData(deps, ['ann@test.dev', '--yes'])).toBe('deleted ann@test.dev: 1 file(s)');
  expect(deletedUsers()).toEqual([`user ${me}`]);
});

test('an unknown email is NotFoundError; a missing, extra or unknown argument is the usage', async () => {
  const { c, calls, deps } = setup();
  c.memory.seedUser({ email: 'ann@test.dev' });
  await expect(deleteUserData(deps, ['nobody@test.dev', '--yes'])).rejects.toBeInstanceOf(NotFoundError);
  for (const args of [
    [],
    ['--yes'],
    ['ann@test.dev', 'extra'],
    ['ann@test.dev', '--force'],
    ['ann@test.dev', '--yes', '--yes'],
    ['ann@test.dev', '--idle-minutes=x'],
    ['ann@test.dev', '--idle-minutes=-1'],
    ['ann@test.dev', '--idle-minutes=1', '--idle-minutes=2'],
  ]) {
    const p = deleteUserData(deps, args);
    await expect(p).rejects.toBeInstanceOf(UsageError);
    await expect(p).rejects.toThrow(DELETE_USER_USAGE);
  }
  expect(calls).toEqual([]);
});
