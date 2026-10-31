import { and, count, eq, inArray, notInArray } from 'drizzle-orm';
import {
  InvalidTransitionError,
  NotFoundError,
  type ExpectedFrom,
  type Task,
  type TaskPatch,
  type TaskRepository,
} from '@agent/core';
import {
  canTransitionTask,
  isExpectedStatus,
  TASK_STATUSES,
  TERMINAL_TASK_STATUSES,
  type TaskStatus,
} from '@agent/shared';
import type { DbHandle } from '../client';
import { tasks, user } from '../schema';
import { isUuid } from '../uuid';

export class DrizzleTaskRepository implements TaskRepository {
  constructor(private readonly deps: { database: DbHandle }) {}
  private get db() {
    return this.deps.database.db;
  }

  async create(input: { userId: string; prompt: string }): Promise<Task> {
    const [owner] = await this.db.select({ id: user.id }).from(user).where(eq(user.id, input.userId));
    if (!owner) throw new NotFoundError('user', input.userId);
    const [row] = await this.db.insert(tasks).values(input).returning();
    return row!;
  }

  async get(id: string): Promise<Task | undefined> {
    if (!isUuid(id)) return undefined;
    const [row] = await this.db.select().from(tasks).where(eq(tasks.id, id));
    return row;
  }

  /** Проверка статуса и запись — один UPDATE … WHERE status IN (допустимые ∩ expectedFrom). */
  async transition(
    id: string,
    to: TaskStatus,
    patch: TaskPatch = {},
    opts: { expectedFrom?: ExpectedFrom<TaskStatus> } = {},
  ): Promise<Task> {
    if (!isUuid(id)) throw new NotFoundError('task', id);
    const allowedFrom = TASK_STATUSES.filter(
      from => canTransitionTask(from, to) && isExpectedStatus(from, opts.expectedFrom),
    );
    const [row] =
      allowedFrom.length === 0
        ? []
        : await this.db
            .update(tasks)
            .set({ ...patch, status: to, updatedAt: new Date() })
            .where(and(eq(tasks.id, id), inArray(tasks.status, allowedFrom)))
            .returning();
    if (row) return row;
    if (!(await this.get(id))) throw new NotFoundError('task', id);
    throw new InvalidTransitionError('task', id, to);
  }

  async update(id: string, patch: TaskPatch): Promise<Task> {
    if (!isUuid(id)) throw new NotFoundError('task', id);
    const [row] = await this.db
      .update(tasks)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(tasks.id, id))
      .returning();
    if (!row) throw new NotFoundError('task', id);
    return row;
  }

  async countActive(userId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(tasks)
      .where(and(eq(tasks.userId, userId), notInArray(tasks.status, [...TERMINAL_TASK_STATUSES])));
    return row?.n ?? 0;
  }
}
