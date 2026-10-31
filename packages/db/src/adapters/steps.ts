import { and, asc, eq, gt, sql, type SQL } from 'drizzle-orm';
import { NotFoundError, type AppendStepInput, type Step, type StepLog } from '@agent/core';
import { StepPayloadSchema } from '@agent/shared';
import type { DbHandle } from '../client';
import { steps, tasks } from '../schema';

export class DrizzleStepLog implements StepLog {
  constructor(private readonly deps: { database: DbHandle }) {}
  private get db() {
    return this.deps.database.db;
  }

  /** seq выдаётся атомарно: строка задачи блокируется на время транзакции. */
  async append(input: AppendStepInput): Promise<Step> {
    const payload = StepPayloadSchema.parse(input.payload);
    return this.db.transaction(async tx => {
      const [counter] = await tx
        .update(tasks)
        .set({ lastSeq: sql`${tasks.lastSeq} + 1`, updatedAt: new Date() })
        .where(eq(tasks.id, input.taskId))
        .returning({ seq: tasks.lastSeq });
      if (!counter) throw new NotFoundError('task', input.taskId);
      const [row] = await tx
        .insert(steps)
        .values({
          taskId: input.taskId,
          subtaskId: input.subtaskId ?? null,
          seq: counter.seq,
          agent: input.agent,
          type: payload.type,
          payload,
          tokensIn: input.tokensIn ?? 0,
          tokensOut: input.tokensOut ?? 0,
        })
        .returning();
      return row!;
    });
  }

  async list(taskId: string, opts: { afterSeq?: number; subtaskId?: string } = {}): Promise<Step[]> {
    const conds: SQL[] = [eq(steps.taskId, taskId)];
    if (opts.afterSeq !== undefined) conds.push(gt(steps.seq, opts.afterSeq));
    if (opts.subtaskId) conds.push(eq(steps.subtaskId, opts.subtaskId));
    return this.db
      .select()
      .from(steps)
      .where(and(...conds))
      .orderBy(asc(steps.seq));
  }
}
