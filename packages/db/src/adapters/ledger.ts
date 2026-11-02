import { desc, eq, sql } from 'drizzle-orm';
import { NotFoundError, type CreditLedger, type TaskUsage, type UsageInput } from '@agent/core';
import type { DbHandle } from '../client';
import { tasks, usageEvents, user } from '../schema';
import { isUuid } from '../uuid';

export class DrizzleCreditLedger implements CreditLedger {
  constructor(private readonly deps: { database: DbHandle }) {}
  private get db() {
    return this.deps.database.db;
  }

  async record(e: UsageInput): Promise<{ balance: number }> {
    return this.db.transaction(async tx => {
      // Сначала пользователь: иначе вставка события упадёт на внешнем ключе вместо NotFoundError.
      const [u] = await tx
        .update(user)
        .set({ millicredits: sql`${user.millicredits} - ${e.millicredits}` })
        .where(eq(user.id, e.userId))
        .returning({ millicredits: user.millicredits });
      if (!u) throw new NotFoundError('user', e.userId);
      if (e.taskId) {
        // Неизвестная задача: исключение откатывает транзакцию вместе со списанием.
        const [t] = isUuid(e.taskId)
          ? await tx
              .update(tasks)
              .set({ tokensUsed: sql`${tasks.tokensUsed} + ${e.tokensIn + e.tokensOut}` })
              .where(eq(tasks.id, e.taskId))
              .returning({ id: tasks.id })
          : [];
        if (!t) throw new NotFoundError('task', e.taskId);
      }
      await tx.insert(usageEvents).values(e);
      return { balance: u.millicredits };
    });
  }

  async grant(email: string, millicredits: number): Promise<{ balance: number }> {
    const [u] = await this.db
      .update(user)
      .set({ millicredits: sql`${user.millicredits} + ${millicredits}`, updatedAt: sql`now()` })
      .where(eq(user.email, email))
      .returning({ millicredits: user.millicredits });
    if (!u) throw new NotFoundError('user', email);
    return { balance: u.millicredits };
  }

  async balance(userId: string): Promise<number> {
    const [u] = await this.db.select({ millicredits: user.millicredits }).from(user).where(eq(user.id, userId));
    if (!u) throw new NotFoundError('user', userId);
    return u.millicredits;
  }

  async spentOnTask(taskId: string): Promise<number> {
    // Кривой id — как неизвестный: Postgres отверг бы его ошибкой формата uuid.
    if (!isUuid(taskId)) return 0;
    const [row] = await this.db
      .select({ total: sql<string | null>`sum(${usageEvents.millicredits})` })
      .from(usageEvents)
      .where(eq(usageEvents.taskId, taskId));
    return Number(row?.total ?? 0);
  }

  /** usage_events.task_id удалённой задачи — null: все такие события собираются в одну строку группировкой. */
  async usageByTask(userId: string, opts: { limit?: number } = {}): Promise<TaskUsage[]> {
    const lastActivity = sql`max(${usageEvents.createdAt})`.mapWith(usageEvents.createdAt);
    const rows = await this.db
      .select({
        taskId: usageEvents.taskId,
        prompt: tasks.prompt,
        // sum по bigint Postgres возвращает строкой (numeric).
        millicredits: sql<string>`sum(${usageEvents.millicredits})`,
        tokens: sql<string>`sum(${usageEvents.tokensIn} + ${usageEvents.tokensOut})`,
        lastActivityAt: lastActivity,
      })
      .from(usageEvents)
      .leftJoin(tasks, eq(tasks.id, usageEvents.taskId))
      .where(eq(usageEvents.userId, userId))
      .groupBy(usageEvents.taskId, tasks.prompt)
      .orderBy(desc(lastActivity))
      .limit(opts.limit ?? 50);
    return rows.map(r => ({ ...r, millicredits: Number(r.millicredits), tokens: Number(r.tokens) }));
  }
}
