import type { Agent, JobKind, StepPayload, StepType, SubtaskReport, SubtaskStatus, TaskStatus } from '@agent/shared';

export interface Task {
  id: string;
  userId: string;
  prompt: string;
  status: TaskStatus;
  currentKind: JobKind | null;
  partial: boolean;
  stopReason: string | null;
  sandboxId: string | null;
  tokensUsed: number;
  activeMs: number;
  lastSeq: number;
  result: string | null;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
}

export type TaskPatch = Partial<
  Pick<Task, 'currentKind' | 'partial' | 'stopReason' | 'sandboxId' | 'result' | 'finishedAt' | 'activeMs'>
>;

export interface Step {
  id: string;
  taskId: string;
  subtaskId: string | null;
  seq: number;
  agent: Agent;
  type: StepType;
  payload: StepPayload;
  tokensIn: number;
  tokensOut: number;
  createdAt: Date;
}

export interface AppendStepInput {
  taskId: string;
  subtaskId?: string | null;
  agent: Agent;
  payload: StepPayload;
  tokensIn?: number;
  tokensOut?: number;
}

export interface Subtask {
  id: string;
  taskId: string;
  idx: number;
  goal: string;
  context: string;
  doneCriteria: string;
  expectedOutputs: string[];
  status: SubtaskStatus;
  attempts: number;
  report: SubtaskReport | null;
  dependsOn: number[];
  createdAt: Date;
  updatedAt: Date;
}

export interface SubtaskPatch {
  report?: SubtaskReport;
  incrementAttempts?: boolean;
}

export type FileKind = 'input' | 'output';

export interface FileRecord {
  id: string;
  taskId: string | null;
  userId: string;
  kind: FileKind;
  path: string;
  storageKey: string;
  size: number;
  mime: string;
  createdAt: Date;
}

export interface NewFile {
  userId: string;
  taskId?: string | null;
  kind: FileKind;
  path: string;
  storageKey: string;
  size: number;
  mime: string;
}

/** Расход по задаче. taskId null — события задач, которых больше нет (и событий без задачи): одна строка. */
export interface TaskUsage {
  taskId: string | null;
  /** Запрос задачи; null, если задачи нет. */
  prompt: string | null;
  millicredits: number;
  /** Токены запроса и ответа вместе. */
  tokens: number;
  lastActivityAt: Date;
}

export interface UsageInput {
  userId: string;
  taskId: string | null;
  model: string;
  tokensIn: number;
  tokensOut: number;
  /** Стоимость вызова в милликредитах. */
  millicredits: number;
}
