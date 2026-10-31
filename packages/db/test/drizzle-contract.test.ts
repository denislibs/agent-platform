import { count } from 'drizzle-orm';
import { repositoryContract } from '@agent/testing';
import {
  DrizzleCreditLedger,
  DrizzleFileRepository,
  DrizzleStepLog,
  DrizzleSubtaskRepository,
  DrizzleTaskRepository,
  usageEvents,
} from '../src';
import { createTestUser, resetDb, setupTestDb } from './helpers';

repositoryContract('drizzle/postgres', async () => {
  const database = await setupTestDb();
  const deps = { database };
  return {
    harness: {
      tasks: new DrizzleTaskRepository(deps),
      steps: new DrizzleStepLog(deps),
      subtasks: new DrizzleSubtaskRepository(deps),
      ledger: new DrizzleCreditLedger(deps),
      files: new DrizzleFileRepository(deps),
      seedUser: async (p = {}) =>
        (await createTestUser(database.db, { credits: p.credits ?? 100, ...(p.email ? { email: p.email } : {}) })).id,
      countUsageEvents: async () => {
        const [row] = await database.db.select({ n: count() }).from(usageEvents);
        return row?.n ?? 0;
      },
      reset: () => resetDb(database.db),
    },
    close: () => database.close(),
  };
});
