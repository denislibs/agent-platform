import {
  InvalidTransitionError,
  NotFoundError,
  type AppendStepInput,
  type CreditLedger,
  type ExpectedFrom,
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
  type TaskCursor,
  type TaskPatch,
  type TaskRepository,
  type TaskUsage,
  type UsageInput,
} from '@agent/core';
import {
  canTransitionSubtask,
  canTransitionTask,
  isExpectedStatus,
  isTerminalTask,
  StepPayloadSchema,
  type SubtaskContract,
  type SubtaskStatus,
  type TaskStatus,
} from '@agent/shared';
import type { InMemoryState } from './state';

type Deps = { memory: InMemoryState };
/** Внутри UnitOfWork.run годятся только репозитории из tx: in-memory ловит то, что Postgres поймал бы лишь по lock_timeout. */
function guardedState(deps: Deps, txToken: symbol | undefined): InMemoryState {
  const scope = deps.memory.txScope.getStore();
  if (scope?.active && scope.token !== txToken) {
    throw new Error('repository from the container used inside UnitOfWork.run: use the tx passed to fn');
  }
  return deps.memory;
}
const copy = <T>(v: T): T => structuredClone(v);
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const newestFirst = <T extends { createdAt: Date; id: string }>(a: T, b: T): number =>
  b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
/** Как ILIKE с экранированным шаблоном: подстрока без учёта регистра. */
const contains = (text: string, search: string): boolean => text.toLowerCase().includes(search.toLowerCase());
/** Как Drizzle .set(): ключи со значением undefined не трогают поле (null — очищает). */
const definedOnly = <T extends object>(patch: T): Partial<T> =>
  Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<T>;

export class InMemoryTaskRepository implements TaskRepository {
  constructor(
    private readonly deps: Deps,
    private readonly txToken?: symbol,
  ) {}
  private get m() {
    return guardedState(this.deps, this.txToken);
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
      cycle: 1,
      cycleBaseTokens: 0,
      cycleBaseActiveMs: 0,
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

  async transition(
    id: string,
    to: TaskStatus,
    patch: TaskPatch = {},
    opts: { expectedFrom?: ExpectedFrom<TaskStatus> } = {},
  ): Promise<Task> {
    const t = this.m.tasks.get(id);
    if (!t) throw new NotFoundError('task', id);
    if (!canTransitionTask(t.status, to) || !isExpectedStatus(t.status, opts.expectedFrom)) {
      throw new InvalidTransitionError('task', id, to);
    }
    Object.assign(t, definedOnly(patch), { status: to, updatedAt: this.m.clock.now() });
    return copy(t);
  }

  async update(id: string, patch: TaskPatch): Promise<Task> {
    const t = this.m.tasks.get(id);
    if (!t) throw new NotFoundError('task', id);
    Object.assign(t, definedOnly(patch), { updatedAt: this.m.clock.now() });
    return copy(t);
  }

  async countActive(userId: string): Promise<number> {
    return [...this.m.tasks.values()].filter(t => t.userId === userId && !isTerminalTask(t.status)).length;
  }

  async listForUser(
    userId: string,
    opts: { limit?: number; before?: TaskCursor; search?: string } = {},
  ): Promise<Task[]> {
    const { before, search } = opts;
    if (before && !CANONICAL_UUID.test(before.id)) return [];
    // newestFirst(t, курсор) > 0: задача t идёт после курсора в порядке выдачи.
    return [...this.m.tasks.values()]
      .filter(
        t =>
          t.userId === userId &&
          (!before || newestFirst(t, { ...t, ...before }) > 0) &&
          (!search || contains(t.prompt, search)),
      )
      .toSorted(newestFirst)
      .slice(0, opts.limit ?? 50)
      .map(copy);
  }

  /** Каскады внешних ключей Postgres: шаги, подзадачи и файлы удаляются, события расхода остаются без задачи. */
  async delete(id: string): Promise<boolean> {
    const m = this.m;
    if (!m.tasks.delete(id)) return false;
    m.steps.splice(0, m.steps.length, ...m.steps.filter(s => s.taskId !== id));
    for (const s of m.subtasks.values()) if (s.taskId === id) m.subtasks.delete(s.id);
    for (const f of m.files.values()) if (f.taskId === id) m.files.delete(f.id);
    for (const e of m.usage) if (e.taskId === id) e.taskId = null;
    return true;
  }

  async findStale(opts: { statuses: readonly TaskStatus[]; staleForMs: number; limit?: number }): Promise<Task[]> {
    const cutoff = this.m.clock.now().getTime() - opts.staleForMs;
    return [...this.m.tasks.values()]
      .filter(t => opts.statuses.includes(t.status) && t.updatedAt.getTime() < cutoff)
      .toSorted((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
      .slice(0, opts.limit ?? 100)
      .map(copy);
  }
}

export class InMemoryStepLog implements StepLog {
  constructor(
    private readonly deps: Deps,
    private readonly txToken?: symbol,
  ) {}
  private get m() {
    return guardedState(this.deps, this.txToken);
  }

  async append(input: AppendStepInput): Promise<Step> {
    const payload = StepPayloadSchema.parse(input.payload);
    const task = this.m.tasks.get(input.taskId);
    if (!task) throw new NotFoundError('task', input.taskId);
    const sub = input.subtaskId ? this.m.subtasks.get(input.subtaskId) : undefined;
    if (input.subtaskId && sub?.taskId !== input.taskId) throw new NotFoundError('subtask', input.subtaskId);
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
  constructor(
    private readonly deps: Deps,
    private readonly txToken?: symbol,
  ) {}
  private get m() {
    return guardedState(this.deps, this.txToken);
  }

  async insertMany(taskId: string, contracts: SubtaskContract[]): Promise<Subtask[]> {
    if (contracts.length === 0) return [];
    const task = this.m.tasks.get(taskId);
    if (!task) throw new NotFoundError('task', taskId);
    const existing = [...this.m.subtasks.values()].filter(s => s.taskId === taskId);
    let next = existing.reduce((max, s) => Math.max(max, s.idx), -1) + 1;
    const now = this.m.clock.now();
    return contracts.map(c => {
      const s: Subtask = {
        id: this.m.ids.uuid(),
        taskId,
        idx: next++,
        cycle: task.cycle,
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

  async get(id: string): Promise<Subtask | undefined> {
    const s = this.m.subtasks.get(id);
    return s && copy(s);
  }

  async updatePending(id: string, patch: Partial<SubtaskContract>): Promise<Subtask> {
    const s = this.m.subtasks.get(id);
    if (!s) throw new NotFoundError('subtask', id);
    if (s.status !== 'pending') throw new InvalidTransitionError('subtask', id, 'pending');
    const { goal, context, doneCriteria, expectedOutputs } = patch;
    Object.assign(
      s,
      definedOnly({ goal, context, doneCriteria, expectedOutputs: expectedOutputs && [...expectedOutputs] }),
      { updatedAt: this.m.clock.now() },
    );
    return copy(s);
  }

  async nextPending(taskId: string): Promise<Subtask | undefined> {
    return (await this.list(taskId)).find(s => s.status === 'pending');
  }

  async transition(
    id: string,
    to: SubtaskStatus,
    patch: SubtaskPatch = {},
    opts: { expectedFrom?: ExpectedFrom<SubtaskStatus> } = {},
  ): Promise<Subtask> {
    const s = this.m.subtasks.get(id);
    if (!s) throw new NotFoundError('subtask', id);
    if (!canTransitionSubtask(s.status, to) || !isExpectedStatus(s.status, opts.expectedFrom)) {
      throw new InvalidTransitionError('subtask', id, to);
    }
    s.status = to;
    s.updatedAt = this.m.clock.now();
    if (patch.report) s.report = copy(patch.report);
    if (patch.incrementAttempts) s.attempts += 1;
    return copy(s);
  }
}

export class InMemoryCreditLedger implements CreditLedger {
  constructor(
    private readonly deps: Deps,
    private readonly txToken?: symbol,
  ) {}
  private get m() {
    return guardedState(this.deps, this.txToken);
  }

  async record(e: UsageInput): Promise<{ balance: number }> {
    const user = this.m.users.get(e.userId);
    if (!user) throw new NotFoundError('user', e.userId);
    const task = e.taskId ? this.m.tasks.get(e.taskId) : undefined;
    if (e.taskId && !task) throw new NotFoundError('task', e.taskId);
    user.millicredits -= e.millicredits;
    this.m.usage.push({ ...e, createdAt: this.m.clock.now() });
    if (task) task.tokensUsed += e.tokensIn + e.tokensOut;
    return { balance: user.millicredits };
  }

  async grant(email: string, millicredits: number): Promise<{ balance: number }> {
    const user = [...this.m.users.values()].find(u => u.email === email);
    if (!user) throw new NotFoundError('user', email);
    user.millicredits += millicredits;
    return { balance: user.millicredits };
  }

  async balance(userId: string): Promise<number> {
    const user = this.m.users.get(userId);
    if (!user) throw new NotFoundError('user', userId);
    return user.millicredits;
  }

  async spentOnTask(taskId: string): Promise<number> {
    return this.m.usage.filter(e => e.taskId === taskId).reduce((n, e) => n + e.millicredits, 0);
  }

  async usageByTask(userId: string, opts: { limit?: number } = {}): Promise<TaskUsage[]> {
    const rows = new Map<string | null, TaskUsage>();
    for (const e of this.m.usage.filter(u => u.userId === userId)) {
      const row = rows.get(e.taskId);
      if (row) {
        row.millicredits += e.millicredits;
        row.tokens += e.tokensIn + e.tokensOut;
        if (e.createdAt > row.lastActivityAt) row.lastActivityAt = e.createdAt;
      } else {
        rows.set(e.taskId, {
          taskId: e.taskId,
          prompt: (e.taskId && this.m.tasks.get(e.taskId)?.prompt) ?? null,
          millicredits: e.millicredits,
          tokens: e.tokensIn + e.tokensOut,
          lastActivityAt: e.createdAt,
        });
      }
    }
    return [...rows.values()]
      .toSorted((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime())
      .slice(0, opts.limit ?? 50)
      .map(copy);
  }
}

export class InMemoryFileRepository implements FileRepository {
  constructor(
    private readonly deps: Deps,
    private readonly txToken?: symbol,
  ) {}
  private get m() {
    return guardedState(this.deps, this.txToken);
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

  async upsertOutput(input: Omit<NewFile, 'kind'>): Promise<FileRecord> {
    const known = [...this.m.files.values()].find(f => f.storageKey === input.storageKey);
    if (!known) return this.insert({ ...input, kind: 'output' });
    Object.assign(known, { size: input.size, mime: input.mime, createdAt: this.m.clock.now() });
    return copy(known);
  }

  async get(id: string): Promise<FileRecord | undefined> {
    const f = this.m.files.get(id);
    return f && copy(f);
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
  async listForUser(userId: string): Promise<FileRecord[]> {
    return [...this.m.files.values()]
      .filter(f => f.userId === userId)
      .toSorted((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map(copy);
  }

  async listOutputs(
    userId: string,
    opts: { limit?: number; before?: TaskCursor; mimes?: readonly string[]; search?: string } = {},
  ): Promise<FileRecord[]> {
    const { before, mimes, search } = opts;
    if (before && !CANONICAL_UUID.test(before.id)) return [];
    return [...this.m.files.values()]
      .filter(
        f =>
          f.userId === userId &&
          f.kind === 'output' &&
          (!mimes || mimes.includes(f.mime)) &&
          (!search || contains(f.path, search)) &&
          (!before || newestFirst(f, { ...f, ...before }) > 0),
      )
      .toSorted(newestFirst)
      .slice(0, opts.limit ?? 50)
      .map(copy);
  }

  async deleteOutput(id: string): Promise<boolean> {
    return this.m.files.get(id)?.kind === 'output' && this.m.files.delete(id);
  }

  async listUnattachedInputs(opts: { olderThanMs: number; limit?: number }): Promise<FileRecord[]> {
    const cutoff = this.m.clock.now().getTime() - opts.olderThanMs;
    return [...this.m.files.values()]
      .filter(f => f.kind === 'input' && f.taskId === null && f.createdAt.getTime() < cutoff)
      .toSorted((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, opts.limit ?? 100)
      .map(copy);
  }

  /** Транзакции in-memory и так идут по одной: блокировка строки не нужна. */
  async lockUnattached(id: string): Promise<FileRecord | undefined> {
    const f = this.m.files.get(id);
    return f && f.kind === 'input' && f.taskId === null ? copy(f) : undefined;
  }

  async deleteUnattached(id: string): Promise<boolean> {
    const f = this.m.files.get(id);
    if (!f || f.kind !== 'input' || f.taskId !== null) return false;
    return this.m.files.delete(id);
  }
}
