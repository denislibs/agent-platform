import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export function createDb(url: string, { max = 10 }: { max?: number } = {}) {
  const client = postgres(url, { max, onnotice: () => {} });
  const db = drizzle({ client, schema });
  return { db, close: () => client.end() };
}

export type DbHandle = ReturnType<typeof createDb>;
export type Db = DbHandle['db'];
