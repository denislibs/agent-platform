import type { FileStore } from './file-store';
import type { Llm } from './llm';
import type { CreditLedger, FileRepository, StepLog, SubtaskRepository, TaskRepository } from './repositories';
import type { Clock, IdGenerator } from './runtime';

export type * from './file-store';
export type * from './llm';
export type * from './repositories';
export type * from './runtime';

/** Реестр портов. Имена полей — ключи регистрации в DI-контейнере. */
export interface Ports {
  tasks: TaskRepository;
  steps: StepLog;
  subtasks: SubtaskRepository;
  ledger: CreditLedger;
  files: FileRepository;
  fileStore: FileStore;
  llm: Llm;
  clock: Clock;
  ids: IdGenerator;
}
