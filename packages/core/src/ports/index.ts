import type { FileStore } from './file-store';
import type { Llm } from './llm';
import type { CreditLedger, FileRepository, StepLog, SubtaskRepository, TaskRepository } from './repositories';
import type { JobQueue } from './queue';
import type { Clock, IdGenerator } from './runtime';
import type { SandboxProvider } from './sandbox';
import type { SearchProvider } from './search';
import type { UnitOfWork } from './unit-of-work';

export type * from './file-store';
export type * from './llm';
export type * from './queue';
export type * from './repositories';
export type * from './runtime';
export type * from './sandbox';
export type * from './search';
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
}
