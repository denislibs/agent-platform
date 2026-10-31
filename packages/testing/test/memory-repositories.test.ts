import { CryptoIds } from '@agent/core';
import {
  FixedClock,
  InMemoryCreditLedger,
  InMemoryFileRepository,
  InMemoryState,
  InMemoryStepLog,
  InMemorySubtaskRepository,
  InMemoryTaskRepository,
  repositoryContract,
} from '@agent/testing';

repositoryContract('in-memory', async () => {
  let memory = new InMemoryState({ clock: new FixedClock(), ids: new CryptoIds() });
  const deps = {
    get memory() {
      return memory;
    },
  };
  return {
    harness: {
      tasks: new InMemoryTaskRepository(deps),
      steps: new InMemoryStepLog(deps),
      subtasks: new InMemorySubtaskRepository(deps),
      ledger: new InMemoryCreditLedger(deps),
      files: new InMemoryFileRepository(deps),
      seedUser: async (p = {}) => memory.seedUser(p),
      countUsageEvents: async () => memory.usage.length,
      reset: async () => {
        memory = new InMemoryState({ clock: new FixedClock(), ids: new CryptoIds() });
      },
    },
    close: async () => {},
  };
});
