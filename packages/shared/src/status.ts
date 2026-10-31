export const TASK_STATUSES = [
  'queued',
  'planning',
  'running',
  'waiting_user',
  'finalizing',
  'done',
  'failed',
  'cancelled',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TERMINAL_TASK_STATUSES = ['done', 'failed', 'cancelled'] as const satisfies readonly TaskStatus[];

const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ['planning'],
  planning: ['running', 'waiting_user', 'finalizing'],
  running: ['waiting_user', 'finalizing'],
  waiting_user: ['planning', 'running', 'finalizing'],
  finalizing: ['done'],
  done: [],
  failed: [],
  cancelled: [],
};

export function isTerminalTask(s: TaskStatus): boolean {
  return (TERMINAL_TASK_STATUSES as readonly TaskStatus[]).includes(s);
}

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  if (isTerminalTask(from)) return false;
  if (to === 'failed' || to === 'cancelled') return true;
  return TASK_TRANSITIONS[from].includes(to);
}

/** Совпадает ли текущий статус с ожидаемым (один статус или список); без ожидания — всегда да. */
export function isExpectedStatus<S extends string>(status: S, expected?: S | readonly S[]): boolean {
  if (expected === undefined) return true;
  return typeof expected === 'string' ? expected === status : expected.includes(status);
}

export const SUBTASK_STATUSES = ['pending', 'running', 'reviewing', 'accepted', 'failed', 'skipped'] as const;
export type SubtaskStatus = (typeof SUBTASK_STATUSES)[number];

const SUBTASK_TRANSITIONS: Record<SubtaskStatus, readonly SubtaskStatus[]> = {
  pending: ['running', 'skipped'],
  running: ['reviewing', 'failed'],
  reviewing: ['accepted', 'running', 'failed'],
  accepted: [],
  failed: [],
  skipped: [],
};

export function canTransitionSubtask(from: SubtaskStatus, to: SubtaskStatus): boolean {
  return SUBTASK_TRANSITIONS[from].includes(to);
}

export const JOB_KINDS = ['plan', 'execute', 'review', 'finalize'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const AGENTS = ['planner', 'executor', 'user', 'system'] as const;
export type Agent = (typeof AGENTS)[number];
