import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { FileKind, FileRecord, FileRepository, NewFile } from '@agent/core';
import type { DbHandle } from '../client';
import { files } from '../schema';

export class DrizzleFileRepository implements FileRepository {
  constructor(private readonly deps: { database: DbHandle }) {}
  private get db() {
    return this.deps.database.db;
  }

  async insert(input: NewFile): Promise<FileRecord> {
    const [row] = await this.db
      .insert(files)
      .values({ ...input, taskId: input.taskId ?? null })
      .returning();
    return row!;
  }

  async listForTask(taskId: string, kind?: FileKind): Promise<FileRecord[]> {
    const where = kind ? and(eq(files.taskId, taskId), eq(files.kind, kind)) : eq(files.taskId, taskId);
    return this.db.select().from(files).where(where).orderBy(asc(files.createdAt));
  }

  async attachToTask(fileIds: string[], userId: string, taskId: string): Promise<number> {
    if (fileIds.length === 0) return 0;
    const rows = await this.db
      .update(files)
      .set({ taskId })
      .where(and(inArray(files.id, fileIds), eq(files.userId, userId), isNull(files.taskId)))
      .returning({ id: files.id });
    return rows.length;
  }
}
