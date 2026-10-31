import { sql } from 'drizzle-orm';
import { createDb, type Db, type DbHandle } from '../src/client';
import { runMigrations } from '../src/migrate';
import { user } from '../src/schema';

/** Защита от TRUNCATE не той базы: имя базы в URL обязано оканчиваться на _test. */
export function assertTestDatabaseUrl(url: string): void {
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  if (!name.endsWith('_test')) {
    throw new Error(
      `Refusing to touch database "${name}": test helpers only run against a database whose name ends with _test`,
    );
  }
}

function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set (see .env.test)');
  assertTestDatabaseUrl(url);
  return url;
}

export async function setupTestDb(): Promise<DbHandle> {
  const url = testDatabaseUrl();
  await runMigrations(url);
  return createDb(url);
}

/** Очищает все таблицы; работает только если TEST_DATABASE_URL указывает на базу *_test. */
export async function resetDb(db: Db): Promise<void> {
  testDatabaseUrl();
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
