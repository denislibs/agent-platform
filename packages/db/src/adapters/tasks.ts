import { and, count, eq, inArray, notInArray } from 'drizzle-orm';
import { InvalidTransitionError, NotFoundError, type Task, type TaskPatch, type TaskRepository } from '@agent/core';
import { canTransitionTask, TASK_STATUSES, TERMINAL_TASK_STATUSES, type TaskStatus } from '@agent/shared';
import type { DbHandle } from '../client';
import { tasks } from '../schema';

export class DrizzleTaskRepository implements TaskRepository {
  constructor(private readonly deps: { database: DbHandle }) {}
  private get db() {
    return this.deps.database.db;
  }

  async create(input: { userId: string; prompt: string }): Promise<Task> {
    const [row] = await this.db.insert(tasks).values(input).returning();
    return row!;
  }

  async get(id: string): Promise<Task | undefined> {
    const [row] = await this.db.select().from(tasks).where(eq(tasks.id, id));
    return row;
  }

  async transition(id: string, to: TaskStatus, patch: TaskPatch = {}): Promise<Task> {
    const allowedFrom = TASK_STATUSES.filter(from => canTransitionTask(from, to));
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
