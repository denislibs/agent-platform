import { afterAll, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { files, user } from '@agent/db';
import { BetterAuthGateway, createBetterAuth, deleteUserData } from '../../src';
import { setupRealApi } from './helpers';

const api = setupRealApi();
afterAll(() => api.dispose());

const input = (userId: string) => ({
  userId,
  kind: 'input' as const,
  path: 'a.csv',
  storageKey: `inputs/${userId}/${crypto.randomUUID()}/a.csv`,
  size: 1,
  mime: 'text/csv',
});

test('on Postgres and Garage: the user row, tasks, files and S3 objects are gone; another user is kept', async () => {
  const { user: me } = await api.signIn();
  const { user: other } = await api.signIn();
  const c = api.container.cradle;
  // Настоящий Better Auth: удаление идёт через его адаптер, каскад — в Postgres.
  const auth = new BetterAuthGateway(
    createBetterAuth({ db: c.database.db, config: c.config, mailer: c.mailer, logger: c.logger, nodeEnv: 'test' }),
  );
  const task = await c.tasks.create({ userId: me.id, prompt: 'x' });
  await c.tasks.transition(task.id, 'cancelled');
  const mine = [
    await c.files.insert(input(me.id)),
    await c.files.insert({
      userId: me.id,
      taskId: task.id,
      kind: 'output',
      path: 'outputs/r.md',
      storageKey: `tasks/${task.id}/outputs/r.md`,
      size: 1,
      mime: 'text/markdown',
    }),
  ];
  const theirs = await c.files.insert(input(other.id));
  for (const f of [...mine, theirs]) await c.fileStore.put(f.storageKey, 'x');
  const { db } = c.database;

  const deps = { auth, files: c.files, fileStore: c.fileStore, tasks: c.tasks };
  // Без --yes — только перечень: ничего не удаляется.
  expect(await deleteUserData(deps, [me.email.toUpperCase()])).toContain(`would delete ${me.email} (user ${me.id})`);
  expect(await db.select().from(user).where(eq(user.id, me.id))).toHaveLength(1);
  for (const f of mine) expect(await c.fileStore.exists(f.storageKey)).toBe(true);

  // Объект, которого уже нет в S3 (повтор после сбоя), удаление не останавливает.
  await c.fileStore.delete(mine[0]!.storageKey);
  expect(await deleteUserData(deps, [me.email.toUpperCase(), '--yes'])).toBe(`deleted ${me.email}: 2 file(s)`);
  expect(await db.select().from(user).where(eq(user.id, me.id))).toEqual([]);
  expect(await db.select().from(files).where(eq(files.userId, me.id))).toEqual([]);
  expect(await c.tasks.get(task.id)).toBeUndefined();
  for (const f of mine) expect(await c.fileStore.exists(f.storageKey)).toBe(false);
  expect(await auth.findUserId(other.email)).toBe(other.id);
  expect(await auth.findUserId(me.email)).toBeUndefined();
  expect(await c.fileStore.exists(theirs.storageKey)).toBe(true);
  await c.fileStore.delete(theirs.storageKey);
});
