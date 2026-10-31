import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  InvalidTransitionError,
  NotFoundError,
  type Subtask,
  type SubtaskPatch,
  type SubtaskRepository,
} from '@agent/core';
import { canTransitionSubtask, SUBTASK_STATUSES, type SubtaskContract, type SubtaskStatus } from '@agent/shared';
import type { DbHandle } from '../client';
import { subtasks } from '../schema';

export class DrizzleSubtaskRepository implements SubtaskRepository {
  constructor(private readonly deps: { database: DbHandle }) {}
  private get db() {
    return this.deps.database.db;
  }

  async insertMany(taskId: string, contracts: SubtaskContract[]): Promise<Subtask[]> {
    if (contracts.length === 0) return [];
    return this.db.transaction(async tx => {
      const [last] = await tx
        .select({ maxIdx: sql<number>`coalesce(max(${subtasks.idx}), -1)` })
        .from(subtasks)
        .where(eq(subtasks.taskId, taskId));
      const start = Number(last?.maxIdx ?? -1) + 1;
      return tx
        .insert(subtasks)
        .values(
          contracts.map((c, i) => ({
            taskId,
            idx: start + i,
            goal: c.goal,
            context: c.context,
            doneCriteria: c.doneCriteria,
            expectedOutputs: c.expectedOutputs,
          })),
        )
        .returning();
    });
  }

  async list(taskId: string): Promise<Subtask[]> {
    return this.db.select().from(subtasks).where(eq(subtasks.taskId, taskId)).orderBy(asc(subtasks.idx));
  }

  async nextPending(taskId: string): Promise<Subtask | undefined> {
    const [row] = await this.db
      .select()
      .from(subtasks)
      .where(and(eq(subtasks.taskId, taskId), eq(subtasks.status, 'pending')))
      .orderBy(asc(subtasks.idx))
      .limit(1);
    return row;
  }

  async transition(id: string, to: SubtaskStatus, patch: SubtaskPatch = {}): Promise<Subtask> {
    const allowedFrom = SUBTASK_STATUSES.filter(from => canTransitionSubtask(from, to));
    const [row] =
      allowedFrom.length === 0
        ? []
        : await this.db
            .update(subtasks)
            .set({
              status: to,
              updatedAt: new Date(),
              ...(patch.report ? { report: patch.report } : {}),
              ...(patch.incrementAttempts ? { attempts: sql`${subtasks.attempts} + 1` } : {}),
            })
            .where(and(eq(subtasks.id, id), inArray(subtasks.status, allowedFrom)))
            .returning();
    if (row) return row;
    const [exists] = await this.db.select({ id: subtasks.id }).from(subtasks).where(eq(subtasks.id, id));
    if (!exists) throw new NotFoundError('subtask', id);
    throw new InvalidTransitionError('subtask', id, to);
  }
}
