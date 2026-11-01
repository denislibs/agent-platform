import type { TaskIntake } from '@agent/agent';
import type {
  Clock,
  CreditLedger,
  FileRepository,
  FileStore,
  IdGenerator,
  JobQueue,
  Logger,
  StepEvents,
  StepLog,
  SubtaskRepository,
  TaskRepository,
  UnitOfWork,
} from '@agent/core';
import type { Config } from '@agent/shared';
import type { AuthGateway, SessionUser } from './auth/gateway';

/** Зависимости API одним объектом: cradle боевого или тестового контейнера подходит как есть. */
export interface ApiDeps {
  config: Config;
  auth: AuthGateway;
  logger: Logger;
  clock: Clock;
  ids: IdGenerator;
  intake: TaskIntake;
  tasks: TaskRepository;
  steps: StepLog;
  subtasks: SubtaskRepository;
  files: FileRepository;
  ledger: CreditLedger;
  uow: UnitOfWork;
  queue: JobQueue;
  fileStore: FileStore;
  stepEvents: StepEvents;
}

export type ApiEnv = { Variables: { user: SessionUser } };
