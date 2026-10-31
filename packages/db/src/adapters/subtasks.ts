import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  InvalidTransitionError,
  NotFoundError,
  type ExpectedFrom,
  type Subtask,
  type SubtaskPatch,
  type SubtaskRepository,
} from '@agent/core';
import {
  canTransitionSubtask,
  isExpectedStatus,
  SUBTASK_STATUSES,
  type SubtaskContract,
  type SubtaskStatus,
} from '@agent/shared';
import type { DbHandle } from '../client';
import { subtasks, tasks } from '../schema';
import { isUuid } from '../uuid';

export class DrizzleSubtaskRepository implements SubtaskRepository {
  constructor(private readonly deps: { database: DbHandle }) {}
  private get db() {
    return this.deps.database.db;
  }

  async insertMany(taskId: string, contracts: SubtaskContract[]): Promise<Subtask[]> {
    if (contracts.length === 0) return [];
    if (!isUuid(taskId)) throw new NotFoundError('task', taskId);
    return this.db.transaction(async tx => {
      // Блокировка строки задачи сериализует выдачу idx: параллельные вызовы ждут коммита предыдущего.
      const [locked] = await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId)).for('update');
      if (!locked) throw new NotFoundError('task', taskId);
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
    if (!isUuid(taskId)) return [];
    return this.db.select().from(subtasks).where(eq(subtasks.taskId, taskId)).orderBy(asc(subtasks.idx));
  }

  async nextPending(taskId: string): Promise<Subtask | undefined> {
    if (!isUuid(taskId)) return undefined;
    const [row] = await this.db
      .select()
      .from(subtasks)
      .where(and(eq(subtasks.taskId, taskId), eq(subtasks.status, 'pending')))
      .orderBy(asc(subtasks.idx))
      .limit(1);
    return row;
  }

  /** Проверка статуса и запись — один UPDATE … WHERE status IN (допустимые ∩ expectedFrom). */
  async transition(
    id: string,
    to: SubtaskStatus,
    patch: SubtaskPatch = {},
    opts: { expectedFrom?: ExpectedFrom<SubtaskStatus> } = {},
  ): Promise<Subtask> {
    if (!isUuid(id)) throw new NotFoundError('subtask', id);
    const allowedFrom = SUBTASK_STATUSES.filter(
      from => canTransitionSubtask(from, to) && isExpectedStatus(from, opts.expectedFrom),
    );
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
