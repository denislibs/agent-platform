import { and, asc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { NotFoundError, type FileKind, type FileRecord, type FileRepository, type NewFile } from '@agent/core';
import type { DbHandle } from '../client';
import { files, tasks, user } from '../schema';
import { isUuid } from '../uuid';

export class DrizzleFileRepository implements FileRepository {
  constructor(private readonly deps: { database: DbHandle }) {}
  private get db() {
    return this.deps.database.db;
  }

  private async assertTaskExists(taskId: string): Promise<void> {
    const [t] = isUuid(taskId) ? await this.db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId)) : [];
    if (!t) throw new NotFoundError('task', taskId);
  }

  async insert(input: NewFile): Promise<FileRecord> {
    const [owner] = await this.db.select({ id: user.id }).from(user).where(eq(user.id, input.userId));
    if (!owner) throw new NotFoundError('user', input.userId);
    if (input.taskId) await this.assertTaskExists(input.taskId);
    const [row] = await this.db
      .insert(files)
      .values({ ...input, taskId: input.taskId ?? null })
      .returning();
    return row!;
  }

  async get(id: string): Promise<FileRecord | undefined> {
    if (!isUuid(id)) return undefined;
    const [row] = await this.db.select().from(files).where(eq(files.id, id));
    return row;
  }

  async listForTask(taskId: string, kind?: FileKind): Promise<FileRecord[]> {
    if (!isUuid(taskId)) return [];
    const where = kind ? and(eq(files.taskId, taskId), eq(files.kind, kind)) : eq(files.taskId, taskId);
    return this.db.select().from(files).where(where).orderBy(asc(files.createdAt));
  }

  async attachToTask(fileIds: string[], userId: string, taskId: string): Promise<number> {
    if (fileIds.length === 0) return 0;
    await this.assertTaskExists(taskId);
    const ids = fileIds.filter(isUuid);
    if (ids.length === 0) return 0;
    const rows = await this.db
      .update(files)
      .set({ taskId })
      .where(and(inArray(files.id, ids), eq(files.userId, userId), isNull(files.taskId)))
      .returning({ id: files.id });
    return rows.length;
  }

  /** Id пользователя — текст Better Auth, не UUID: проверка isUuid не нужна. */
  async listForUser(userId: string): Promise<FileRecord[]> {
    return this.db.select().from(files).where(eq(files.userId, userId)).orderBy(asc(files.createdAt));
  }

  /**
   * Индекс не нужен: выборка раз в минуту по таблице files беты; при росте — частичный индекс
   * (created_at) WHERE task_id IS NULL AND kind = 'input'.
   */
  async listUnattachedInputs(opts: { olderThanMs: number; limit?: number }): Promise<FileRecord[]> {
    return this.db
      .select()
      .from(files)
      .where(
        and(
          eq(files.kind, 'input'),
          isNull(files.taskId),
          lt(files.createdAt, sql`now() - make_interval(secs => ${opts.olderThanMs / 1000}::double precision)`),
        ),
      )
      .orderBy(asc(files.createdAt))
      .limit(opts.limit ?? 100);
  }

  async lockUnattached(id: string): Promise<FileRecord | undefined> {
    if (!isUuid(id)) return undefined;
    const [row] = await this.db
      .select()
      .from(files)
      .where(and(eq(files.id, id), eq(files.kind, 'input'), isNull(files.taskId)))
      .for('update');
    return row;
  }

  async deleteUnattached(id: string): Promise<boolean> {
    if (!isUuid(id)) return false;
    const rows = await this.db
      .delete(files)
      .where(and(eq(files.id, id), eq(files.kind, 'input'), isNull(files.taskId)))
      .returning({ id: files.id });
    return rows.length > 0;
  }
}
