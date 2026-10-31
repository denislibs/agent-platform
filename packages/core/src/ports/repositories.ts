import type { SubtaskContract, SubtaskStatus, TaskStatus } from '@agent/shared';
import type {
  AppendStepInput,
  FileKind,
  FileRecord,
  NewFile,
  Step,
  Subtask,
  SubtaskPatch,
  Task,
  TaskPatch,
  UsageInput,
} from '../entities';

/** transition/update бросают NotFoundError для неизвестной задачи и InvalidTransitionError для запрещённого перехода. */
export interface TaskRepository {
  create(input: { userId: string; prompt: string }): Promise<Task>;
  get(id: string): Promise<Task | undefined>;
  transition(id: string, to: TaskStatus, patch?: TaskPatch): Promise<Task>;
  update(id: string, patch: TaskPatch): Promise<Task>;
  /** Задачи пользователя в нефинальных статусах. */
  countActive(userId: string): Promise<number>;
}

/** Лента шагов. seq растёт на 1 внутри задачи и не повторяется даже при параллельной записи. */
export interface StepLog {
  append(input: AppendStepInput): Promise<Step>;
  list(taskId: string, opts?: { afterSeq?: number; subtaskId?: string }): Promise<Step[]>;
}

export interface SubtaskRepository {
  /** idx продолжает нумерацию задачи с 0 (повторный вызов — это replan). */
  insertMany(taskId: string, contracts: SubtaskContract[]): Promise<Subtask[]>;
  list(taskId: string): Promise<Subtask[]>;
  nextPending(taskId: string): Promise<Subtask | undefined>;
  transition(id: string, to: SubtaskStatus, patch?: SubtaskPatch): Promise<Subtask>;
}

/** Учёт расхода: событие, списание кредитов и токены задачи — атомарно. Баланс может уйти в минус. */
export interface CreditLedger {
  record(e: UsageInput): Promise<{ balance: number }>;
  grant(email: string, amount: number): Promise<{ balance: number }>;
}

export interface FileRepository {
  insert(input: NewFile): Promise<FileRecord>;
  listForTask(taskId: string, kind?: FileKind): Promise<FileRecord[]>;
  /** Привязывает только файлы этого пользователя, ещё не привязанные к задаче. Возвращает их число. */
  attachToTask(fileIds: string[], userId: string, taskId: string): Promise<number>;
}
