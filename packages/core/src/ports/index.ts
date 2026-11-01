import type { FileStore } from './file-store';
import type { Llm } from './llm';
import type { Logger } from './logger';
import type { Mailer } from './mailer';
import type { CreditLedger, FileRepository, StepLog, SubtaskRepository, TaskRepository } from './repositories';
import type { JobQueue } from './queue';
import type { Clock, IdGenerator } from './runtime';
import type { SandboxProvider } from './sandbox';
import type { SearchProvider } from './search';
import type { StepEvents } from './step-events';
import type { UnitOfWork } from './unit-of-work';

export type * from './file-store';
export type * from './llm';
export type * from './logger';
export type * from './mailer';
export type * from './queue';
export type * from './repositories';
export type * from './runtime';
export type * from './sandbox';
export type * from './search';
export type * from './step-events';
export type * from './unit-of-work';

/** Реестр портов. Имена полей — ключи регистрации в DI-контейнере. */
export interface Ports {
  tasks: TaskRepository;
  steps: StepLog;
  subtasks: SubtaskRepository;
  ledger: CreditLedger;
  files: FileRepository;
  uow: UnitOfWork;
  fileStore: FileStore;
  llm: Llm;
  clock: Clock;
  ids: IdGenerator;
  sandboxes: SandboxProvider;
  search: SearchProvider;
  queue: JobQueue;
  logger: Logger;
  mailer: Mailer;
  stepEvents: StepEvents;
}
