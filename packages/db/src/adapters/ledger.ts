import { eq, sql } from 'drizzle-orm';
import { NotFoundError, type CreditLedger, type UsageInput } from '@agent/core';
import type { DbHandle } from '../client';
import { tasks, usageEvents, user } from '../schema';

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
        .set({ credits: sql`${user.credits} - ${e.credits}` })
        .where(eq(user.id, e.userId))
        .returning({ credits: user.credits });
      if (!u) throw new NotFoundError('user', e.userId);
      await tx.insert(usageEvents).values(e);
      if (e.taskId) {
        await tx
          .update(tasks)
          .set({ tokensUsed: sql`${tasks.tokensUsed} + ${e.tokensIn + e.tokensOut}` })
          .where(eq(tasks.id, e.taskId));
      }
      return { balance: u.credits };
    });
  }

  async grant(email: string, amount: number): Promise<{ balance: number }> {
    const [u] = await this.db
      .update(user)
      .set({ credits: sql`${user.credits} + ${amount}`, updatedAt: new Date() })
      .where(eq(user.email, email))
      .returning({ credits: user.credits });
    if (!u) throw new NotFoundError('user', email);
    return { balance: u.credits };
  }
}
