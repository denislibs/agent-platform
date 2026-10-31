import { sql } from 'drizzle-orm';
import { createDb, type Db, type DbHandle } from '../src/client';
import { runMigrations } from '../src/migrate';
import { user } from '../src/schema';

export async function setupTestDb(): Promise<DbHandle> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set (see .env.test)');
  await runMigrations(url);
  return createDb(url);
}

export async function resetDb(db: Db): Promise<void> {
  await db.execute(
    sql`TRUNCATE "user", session, account, verification, tasks, subtasks, steps, files, usage_events CASCADE`,
  );
}

export async function createTestUser(db: Db, patch: Partial<typeof user.$inferInsert> = {}) {
  const [row] = await db
    .insert(user)
    .values({
      id: crypto.randomUUID(),
      name: 'Test User',
      email: `${crypto.randomUUID()}@test.dev`,
      credits: 100,
      ...patch,
    })
    .returning();
  return row!;
}
