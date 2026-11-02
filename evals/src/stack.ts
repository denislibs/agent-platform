import { Queue } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import { buildContainer } from '@agent/composition';
import { createDb, runMigrations, user, type Db } from '@agent/db';
import { AGENT_QUEUE } from '@agent/queue';
import type { Config } from '@agent/shared';
import { startWorker } from '@agent/worker';
import { cancelUnfinished, type EvalStack } from './run';

/** Пользователь, от имени которого идут задачи evals. */
export const EVALS_EMAIL = 'evals@agent.local';
/** Как часто прогон смотрит на задачу: воркер в том же процессе работает сам. */
const POLL_MS = 1000;

/** База evals создаётся сама при первом прогоне (init.sql создаёт её только на новом томе Postgres). */
async function ensureDatabase(url: string): Promise<void> {
  const target = new URL(url);
  const name = decodeURIComponent(target.pathname.slice(1));
  if (!/^[a-z0-9_]+_evals$/.test(name)) throw new Error(`refusing to create database "${name}"`);
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const { db, close } = createDb(admin.toString(), { max: 1 });
  try {
    const found = await db.execute(sql`select 1 from pg_database where datname = ${name}`);
    if (found.length === 0) await db.execute(sql.raw(`CREATE DATABASE "${name}"`));
  } finally {
    await close();
  }
}

async function ensureUser(db: Db, email: string): Promise<string> {
  await db
    .insert(user)
    .values({ id: crypto.randomUUID(), name: 'Evals', email, millicredits: 0 })
    .onConflictDoNothing({ target: user.email });
  const [row] = await db.select({ id: user.id }).from(user).where(eq(user.email, email));
  if (!row) throw new Error(`could not create the evals user ${email}`);
  return row.id;
}

/**
 * Настоящий стек в одном процессе (как сквозной тест воркера): Postgres (база *_evals), Valkey (своя очередь),
 * S3, Docker-песочницы, LiteLLM и Brave из .env. API не нужен: задачи ставит TaskIntake, ответы и отмену делают те же
 * функции, что и маршруты API.
 */
export async function openStack(config: Config): Promise<{ stack: EvalStack; close(): Promise<void> }> {
  // Контейнер ленивый: ничего не подключает, пока зависимость не запрошена.
  const container = buildContainer(config);
  const c = container.cradle;
  let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
  let userId: string;
  try {
    // Первым делом: без LITELLM_* или моделей createLlm бросает понятную ошибку — до создания базы и воркера.
    void c.llm;
    await ensureDatabase(config.databaseUrl);
    await runMigrations(config.databaseUrl);
    userId = await ensureUser(c.database.db, EVALS_EMAIL);
    // До воркера: задачи прерванного прогона иначе подхватил бы сборщик и они заняли бы единственный слот.
    const leftovers = await cancelUnfinished(c, userId);
    if (leftovers > 0) console.log(`[evals] cancelled ${leftovers} unfinished task(s) left by an earlier run`);
    worker = await startWorker(c);
  } catch (err) {
    // Сбой старта не оставляет открытых соединений: процесс завершится с понятной ошибкой, а не повиснет.
    await worker?.close().catch(() => undefined);
    await container.dispose().catch(() => undefined);
    throw err;
  }
  const running = worker;
  return {
    stack: {
      deps: c,
      user: { id: userId, email: EVALS_EMAIL },
      searchAvailable: config.search.braveApiKey !== null,
      tick: () => Bun.sleep(POLL_MS),
    },
    async close() {
      await running.close();
      const queue = new Queue(AGENT_QUEUE, { connection: c.redis, prefix: config.worker.queuePrefix });
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close();
      await container.dispose();
    },
  };
}
