import {
  InvalidTransitionError,
  NotFoundError,
  type AppendStepInput,
  type CreditLedger,
  type FileKind,
  type FileRecord,
  type FileRepository,
  type NewFile,
  type Step,
  type StepLog,
  type Subtask,
  type SubtaskPatch,
  type SubtaskRepository,
  type Task,
  type TaskPatch,
  type TaskRepository,
  type UsageInput,
} from '@agent/core';
import {
  canTransitionSubtask,
  canTransitionTask,
  isTerminalTask,
  StepPayloadSchema,
  type SubtaskContract,
  type SubtaskStatus,
  type TaskStatus,
} from '@agent/shared';
import type { InMemoryState } from './state';

type Deps = { memory: InMemoryState };
const copy = <T>(v: T): T => structuredClone(v);

export class InMemoryTaskRepository implements TaskRepository {
  constructor(private readonly deps: Deps) {}
  private get m() {
    return this.deps.memory;
  }

  async create(input: { userId: string; prompt: string }): Promise<Task> {
    if (!this.m.users.has(input.userId)) throw new NotFoundError('user', input.userId);
    const now = this.m.clock.now();
    const task: Task = {
      id: this.m.ids.uuid(),
      userId: input.userId,
      prompt: input.prompt,
      status: 'queued',
      currentKind: null,
      partial: false,
      stopReason: null,
      sandboxId: null,
      tokensUsed: 0,
      activeMs: 0,
      lastSeq: 0,
      result: null,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
    };
    this.m.tasks.set(task.id, task);
    return copy(task);
  }

  async get(id: string): Promise<Task | undefined> {
    const t = this.m.tasks.get(id);
    return t && copy(t);
  }

  async transition(id: string, to: TaskStatus, patch: TaskPatch = {}): Promise<Task> {
    const t = this.m.tasks.get(id);
    if (!t) throw new NotFoundError('task', id);
    if (!canTransitionTask(t.status, to)) throw new InvalidTransitionError('task', id, to);
    Object.assign(t, patch, { status: to, updatedAt: this.m.clock.now() });
    return copy(t);
  }

  async update(id: string, patch: TaskPatch): Promise<Task> {
    const t = this.m.tasks.get(id);
    if (!t) throw new NotFoundError('task', id);
    Object.assign(t, patch, { updatedAt: this.m.clock.now() });
    return copy(t);
  }

  async countActive(userId: string): Promise<number> {
    return [...this.m.tasks.values()].filter(t => t.userId === userId && !isTerminalTask(t.status)).length;
  }
}

export class InMemoryStepLog implements StepLog {
  constructor(private readonly deps: Deps) {}
  private get m() {
    return this.deps.memory;
  }

  async append(input: AppendStepInput): Promise<Step> {
    const payload = StepPayloadSchema.parse(input.payload);
    const task = this.m.tasks.get(input.taskId);
    if (!task) throw new NotFoundError('task', input.taskId);
    if (input.subtaskId && !this.m.subtasks.has(input.subtaskId)) throw new NotFoundError('subtask', input.subtaskId);
    task.lastSeq += 1;
    task.updatedAt = this.m.clock.now();
    const step: Step = {
      id: this.m.ids.uuid(),
      taskId: input.taskId,
      subtaskId: input.subtaskId ?? null,
      seq: task.lastSeq,
      agent: input.agent,
      type: payload.type,
      payload,
      tokensIn: input.tokensIn ?? 0,
      tokensOut: input.tokensOut ?? 0,
      createdAt: this.m.clock.now(),
    };
    this.m.steps.push(step);
    return copy(step);
  }

  async list(taskId: string, opts: { afterSeq?: number; subtaskId?: string } = {}): Promise<Step[]> {
    return this.m.steps
      .filter(
        s =>
          s.taskId === taskId &&
          (opts.afterSeq === undefined || s.seq > opts.afterSeq) &&
          (!opts.subtaskId || s.subtaskId === opts.subtaskId),
      )
      .toSorted((a, b) => a.seq - b.seq)
      .map(copy);
  }
}

export class InMemorySubtaskRepository implements SubtaskRepository {
  constructor(private readonly deps: Deps) {}
  private get m() {
    return this.deps.memory;
  }

  async insertMany(taskId: string, contracts: SubtaskContract[]): Promise<Subtask[]> {
    if (contracts.length === 0) return [];
    if (!this.m.tasks.has(taskId)) throw new NotFoundError('task', taskId);
    const existing = [...this.m.subtasks.values()].filter(s => s.taskId === taskId);
    let next = existing.reduce((max, s) => Math.max(max, s.idx), -1) + 1;
    const now = this.m.clock.now();
    return contracts.map(c => {
      const s: Subtask = {
        id: this.m.ids.uuid(),
        taskId,
        idx: next++,
        goal: c.goal,
        context: c.context,
        doneCriteria: c.doneCriteria,
        expectedOutputs: [...c.expectedOutputs],
        status: 'pending',
        attempts: 0,
        report: null,
        dependsOn: [],
        createdAt: now,
        updatedAt: now,
      };
      this.m.subtasks.set(s.id, s);
      return copy(s);
    });
  }

  async list(taskId: string): Promise<Subtask[]> {
    return [...this.m.subtasks.values()]
      .filter(s => s.taskId === taskId)
      .toSorted((a, b) => a.idx - b.idx)
      .map(copy);
  }

  async nextPending(taskId: string): Promise<Subtask | undefined> {
    return (await this.list(taskId)).find(s => s.status === 'pending');
  }

  async transition(id: string, to: SubtaskStatus, patch: SubtaskPatch = {}): Promise<Subtask> {
    const s = this.m.subtasks.get(id);
    if (!s) throw new NotFoundError('subtask', id);
    if (!canTransitionSubtask(s.status, to)) throw new InvalidTransitionError('subtask', id, to);
    s.status = to;
    s.updatedAt = this.m.clock.now();
    if (patch.report) s.report = copy(patch.report);
    if (patch.incrementAttempts) s.attempts += 1;
    return copy(s);
  }
}

export class InMemoryCreditLedger implements CreditLedger {
  constructor(private readonly deps: Deps) {}
  private get m() {
    return this.deps.memory;
  }

  async record(e: UsageInput): Promise<{ balance: number }> {
    const user = this.m.users.get(e.userId);
    if (!user) throw new NotFoundError('user', e.userId);
    const task = e.taskId ? this.m.tasks.get(e.taskId) : undefined;
    if (e.taskId && !task) throw new NotFoundError('task', e.taskId);
    user.credits -= e.credits;
    this.m.usage.push({ ...e, createdAt: this.m.clock.now() });
    if (task) task.tokensUsed += e.tokensIn + e.tokensOut;
    return { balance: user.credits };
  }

  async grant(email: string, amount: number): Promise<{ balance: number }> {
    const user = [...this.m.users.values()].find(u => u.email === email);
    if (!user) throw new NotFoundError('user', email);
    user.credits += amount;
    return { balance: user.credits };
  }
}

export class InMemoryFileRepository implements FileRepository {
  constructor(private readonly deps: Deps) {}
  private get m() {
    return this.deps.memory;
  }

  async insert(input: NewFile): Promise<FileRecord> {
    if (!this.m.users.has(input.userId)) throw new NotFoundError('user', input.userId);
    if (input.taskId && !this.m.tasks.has(input.taskId)) throw new NotFoundError('task', input.taskId);
    const f: FileRecord = {
      ...input,
      taskId: input.taskId ?? null,
      id: this.m.ids.uuid(),
      createdAt: this.m.clock.now(),
    };
    this.m.files.set(f.id, f);
    return copy(f);
  }

  async listForTask(taskId: string, kind?: FileKind): Promise<FileRecord[]> {
    return [...this.m.files.values()].filter(f => f.taskId === taskId && (!kind || f.kind === kind)).map(copy);
  }

  async attachToTask(fileIds: string[], userId: string, taskId: string): Promise<number> {
    if (fileIds.length === 0) return 0;
    if (!this.m.tasks.has(taskId)) throw new NotFoundError('task', taskId);
    let n = 0;
    for (const id of fileIds) {
      const f = this.m.files.get(id);
      if (f && f.userId === userId && f.taskId === null) {
        f.taskId = taskId;
        n++;
      }
    }
    return n;
  }
}
