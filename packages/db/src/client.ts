import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

/** Сколько запрос ждёт чужую блокировку, прежде чем упасть с ошибкой Postgres 55P03 (lock_not_available). */
export const DEFAULT_LOCK_TIMEOUT_MS = 10_000;

/**
 * Пул соединений. lock_timeout ставится каждому соединению: запрос репозитория из контейнера,
 * ошибочно вызванный внутри UnitOfWork.run и заблокированный этой же транзакцией, падает, а не висит вечно.
 */
export function createDb(
  url: string,
  { max = 10, lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS }: { max?: number; lockTimeoutMs?: number } = {},
) {
  const client = postgres(url, { max, onnotice: () => {}, connection: { lock_timeout: lockTimeoutMs } });
  const db = drizzle({ client, schema });
  return { db, close: () => client.end() };
}

export type DbHandle = ReturnType<typeof createDb>;
export type Db = DbHandle['db'];
