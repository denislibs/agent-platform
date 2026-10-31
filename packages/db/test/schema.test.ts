import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { createTestUser, resetDb, setupTestDb } from './helpers';
import { steps, tasks } from '../src/schema';
import type { DbHandle } from '../src/client';

let h: DbHandle;
beforeAll(async () => {
  h = await setupTestDb();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await resetDb(h.db);
});

test('migrations create all tables', async () => {
  const rows = await h.db.execute<{ table_name: string }>(
    sql`select table_name from information_schema.tables where table_schema = 'public'`,
  );
  const names = [...rows].map(r => r.table_name);
  for (const name of [
    'user',
    'session',
    'account',
    'verification',
    'tasks',
    'subtasks',
    'steps',
    'files',
    'usage_events',
  ]) {
    expect(names).toContain(name);
  }
});

test('unique (task_id, seq) is enforced by the database', async () => {
  const u = await createTestUser(h.db);
  const [task] = await h.db.insert(tasks).values({ userId: u.id, prompt: 'hi' }).returning();
  const payload = { type: 'message', role: 'user', text: 'hi' } as const;
  await h.db.insert(steps).values({ taskId: task!.id, seq: 1, agent: 'user', type: 'message', payload });
  // Drizzle query builders are thenables, not Promises; bun's `.rejects` needs a real Promise.
  const duplicate = Promise.resolve(
    h.db.insert(steps).values({ taskId: task!.id, seq: 1, agent: 'user', type: 'message', payload }),
  );
  await expect(duplicate).rejects.toThrow();
});

test('deleting a user cascades to tasks', async () => {
  const u = await createTestUser(h.db);
  await h.db.insert(tasks).values({ userId: u.id, prompt: 'hi' });
  await h.db.execute(sql`delete from "user" where id = ${u.id}`);
  expect(await h.db.select().from(tasks)).toHaveLength(0);
});
