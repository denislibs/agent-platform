import { z } from 'zod';
import type { TaskCursor } from '@agent/core';
import { ApiError } from './errors';

const CursorSchema = z.object({ t: z.iso.datetime(), id: z.uuid() });

/** Непрозрачный курсор страницы: base64url от { t, id } последней задачи. */
export function encodeCursor(cursor: TaskCursor): string {
  return Buffer.from(JSON.stringify({ t: cursor.createdAt.toISOString(), id: cursor.id })).toString('base64url');
}

/**
 * Курсор принимается только в той записи, которую выдаёт encodeCursor: после разбора он кодируется заново и
 * сравнивается с входом. Так отсеиваются непарные символы base64, пробелы в JSON, лишние поля, даты без
 * миллисекунд или с несуществующим днём; id принимается только в нижнем регистре.
 */
export function decodeCursor(raw: string): TaskCursor {
  try {
    const parsed = CursorSchema.safeParse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
    if (parsed.success) {
      const cursor = { createdAt: new Date(parsed.data.t), id: parsed.data.id };
      if (cursor.id === cursor.id.toLowerCase() && encodeCursor(cursor) === raw) return cursor;
    }
  } catch {
    // не JSON или дата вне диапазона — тот же ответ
  }
  throw new ApiError(400, 'bad_request', 'invalid cursor');
}
