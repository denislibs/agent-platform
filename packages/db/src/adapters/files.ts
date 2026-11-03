import { and, asc, desc, eq, ilike, inArray, isNull, lt, sql } from 'drizzle-orm';
import {
  NotFoundError,
  type FileKind,
  type FileRecord,
  type FileRepository,
  type NewFile,
  type TaskCursor,
} from '@agent/core';
import type { DbHandle } from '../client';
import { containsPattern } from '../like';
import { files, tasks } from '../schema';
import { isUuid } from '../uuid';

/** Postgres: нарушение внешнего ключа. */
const FOREIGN_KEY_VIOLATION = '23503';

/** Имя нарушенного внешнего ключа; drizzle заворачивает ошибку драйвера в `cause`. */
function foreignKeyViolation(err: unknown): string | undefined {
  for (
    let e: unknown = err, depth = 0;
    e && typeof e === 'object' && depth < 3;
    e = (e as { cause?: unknown }).cause, depth++
  ) {
    const { code, constraint_name: constraint } = e as { code?: unknown; constraint_name?: unknown };
    if (code === FOREIGN_KEY_VIOLATION && typeof constraint === 'string') return constraint;
  }
  return undefined;
}

export class DrizzleFileRepository implements FileRepository {
  constructor(private readonly deps: { database: DbHandle }) {}
  private get db() {
    return this.deps.database.db;
  }

  private async assertTaskExists(taskId: string): Promise<void> {
    const [t] = isUuid(taskId) ? await this.db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId)) : [];
    if (!t) throw new NotFoundError('task', taskId);
  }

  /**
   * Запись строки files. Без предварительной проверки: задачу или пользователя могли удалить между проверкой и
   * вставкой. Нарушенный внешний ключ — контракт порта: NotFoundError с той сущностью, на которую он указывал.
   */
  private async write(input: NewFile, query: () => Promise<FileRecord[]>): Promise<FileRecord | undefined> {
    // Кривой id задачи не дойдёт до Postgres как ошибка формата (22P02).
    if (input.taskId && !isUuid(input.taskId)) throw new NotFoundError('task', input.taskId);
    try {
      const [row] = await query();
      return row;
    } catch (err) {
      const violation = foreignKeyViolation(err);
      if (violation === 'files_task_id_tasks_id_fk') throw new NotFoundError('task', input.taskId ?? '');
      if (violation === 'files_user_id_user_id_fk') throw new NotFoundError('user', input.userId);
      throw err;
    }
  }

  async insert(input: NewFile): Promise<FileRecord> {
    const row = await this.write(input, () =>
      this.db
        .insert(files)
        .values({ ...input, taskId: input.taskId ?? null })
        .returning(),
    );
    return row!;
  }

  /**
   * storage_key уникален (schema.ts), а ключ результата строится из задачи и пути: отдельный индекс не нужен.
   * Обновляется только тот же результат того же пользователя и той же задачи; ключ, занятый чужой строкой или
   * входным файлом, — ошибка программиста: Error, строка не меняется.
   */
  async upsertOutput(input: Omit<NewFile, 'kind'>): Promise<FileRecord> {
    const record: NewFile = { ...input, kind: 'output' };
    const taskId = record.taskId ?? null;
    const row = await this.write(record, () =>
      this.db
        .insert(files)
        .values({ ...record, taskId })
        .onConflictDoUpdate({
          target: files.storageKey,
          set: { size: record.size, mime: record.mime, createdAt: sql`now()` },
          setWhere: and(
            eq(files.userId, record.userId),
            taskId === null ? isNull(files.taskId) : eq(files.taskId, taskId),
            eq(files.kind, 'output'),
          ),
        })
        .returning(),
    );
    if (!row) throw new Error(`storage key ${record.storageKey} belongs to another file`);
    return row;
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

  async listOutputs(
    userId: string,
    opts: { limit?: number; before?: TaskCursor; mimes?: readonly string[]; search?: string } = {},
  ): Promise<FileRecord[]> {
    const { before, mimes, search } = opts;
    if ((before && !isUuid(before.id)) || mimes?.length === 0) return [];
    // Время усечено до мс по той же причине, что в DrizzleTaskRepository.listForUser: курсор хранит Date.
    const createdMs = sql`date_trunc('milliseconds', ${files.createdAt})`;
    return this.db
      .select()
      .from(files)
      .where(
        and(
          eq(files.userId, userId),
          eq(files.kind, 'output'),
          mimes ? inArray(files.mime, [...mimes]) : undefined,
          search ? ilike(files.path, containsPattern(search)) : undefined,
          before
            ? sql`(${createdMs}, ${files.id}) < (${before.createdAt.toISOString()}::timestamptz, ${before.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(createdMs), desc(files.id))
      .limit(opts.limit ?? 50);
  }

  async deleteOutput(id: string): Promise<boolean> {
    if (!isUuid(id)) return false;
    const rows = await this.db
      .delete(files)
      .where(and(eq(files.id, id), eq(files.kind, 'output')))
      .returning({ id: files.id });
    return rows.length > 0;
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
