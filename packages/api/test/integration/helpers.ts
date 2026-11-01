import { asValue } from 'awilix';
import { Queue } from 'bullmq';
import { inArray } from 'drizzle-orm';
import { buildContainer, type Overrides } from '@agent/composition';
import { user } from '@agent/db';
import { AGENT_QUEUE } from '@agent/queue';
import { loadConfig } from '@agent/shared';
import { createApp, type SessionUser } from '../../src';
import { FakeAuth } from '../fake-auth';

/** Только база *_test: тесты создают пользователей и задачи. */
function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set (see .env.test)');
  if (!new URL(url).pathname.endsWith('_test')) throw new Error(`refusing to use a non-test database: ${url}`);
  return url;
}

/** API на настоящих адаптерах (Postgres, Valkey, Garage) с FakeAuth: вход Better Auth проверяет auth.test.ts. */
export function setupRealApi(overrides: Overrides = {}) {
  // Свой префикс ключей BullMQ: job тестов не попадут к воркеру разработки и не переживут прогон.
  const config = loadConfig({
    ...process.env,
    DATABASE_URL: testDatabaseUrl(),
    QUEUE_PREFIX: `api-it-${crypto.randomUUID()}`,
  });
  const auth = new FakeAuth();
  const container = buildContainer(config, overrides).register({ auth: asValue(auth) });
  const app = createApp(container.cradle);
  const userIds: string[] = [];

  async function signIn(millicredits = 1_000_000) {
    const [row] = await container.cradle.database.db
      .insert(user)
      .values({ id: crypto.randomUUID(), name: 'API', email: `${crypto.randomUUID()}@test.dev`, millicredits })
      .returning();
    userIds.push(row!.id);
    const session: SessionUser = { id: row!.id, email: row!.email, name: row!.name, image: null };
    // Origin приложения: изменяющие запросы без него отклоняет csrf.
    const origin = new URL(config.auth.baseUrl).origin;
    return { user: session, headers: { cookie: `session=${auth.signIn(session)}`, origin } };
  }

  /** Удаляет созданных пользователей (задачи и файлы уходят каскадом), очередь теста и закрывает соединения. */
  async function dispose() {
    const c = container.cradle;
    if (userIds.length > 0) await c.database.db.delete(user).where(inArray(user.id, userIds));
    const raw = new Queue(AGENT_QUEUE, { connection: c.redis, prefix: config.worker.queuePrefix });
    try {
      await raw.obliterate({ force: true });
    } finally {
      await raw.close();
    }
    await container.dispose();
  }

  return { config, container, app, signIn, dispose };
}
