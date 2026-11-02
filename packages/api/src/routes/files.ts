import type { Hono } from 'hono';
import {
  FILE_CATEGORIES,
  ListFilesQuerySchema,
  UploadBodySchema,
  type FileListResponse,
  type UploadResponse,
} from '@agent/shared';
import { decodeCursor, encodeCursor } from '../cursor';
import type { ApiDeps, ApiEnv } from '../deps';
import { toFileDto } from '../dto';
import { ApiError } from '../errors';
import { baseName, safeFileName } from '../file-names';
import { parseJson, parseQuery } from '../http';

export function fileRoutes(app: Hono<ApiEnv>, deps: ApiDeps): void {
  /**
   * Входной файл: запись files (ещё без задачи) и presigned PUT. Сам файл браузер грузит прямо в S3.
   * Ключ строится только из id пользователя и нового uuid; от клиента в нём лишь очищенное имя файла.
   * Content-Type подписывается в PUT как есть: скачивание всегда attachment, так что тип не опасен.
   */
  app.post('/api/uploads', async c => {
    const user = c.get('user');
    const body = await parseJson(c, UploadBodySchema);
    const limit = deps.config.api.uploadMaxBytes;
    if (body.size > limit) throw new ApiError(413, 'payload_too_large', `files are limited to ${limit} bytes`);
    const name = safeFileName(body.name);
    const storageKey = `inputs/${user.id}/${deps.ids.uuid()}/${name}`;
    const file = await deps.files.insert({
      userId: user.id,
      kind: 'input',
      path: name,
      storageKey,
      size: body.size,
      mime: body.contentType,
    });
    const url = await deps.fileStore.presignPut(storageKey, { contentType: body.contentType, size: body.size });
    const response: UploadResponse = {
      file: toFileDto(file),
      upload: { url, method: 'PUT', headers: { 'content-type': body.contentType } },
    };
    return c.json(response, 201);
  });

  /** Library: результаты задач пользователя, новые первыми; страницы по курсору, как у GET /api/tasks. */
  app.get('/api/files', async c => {
    const query = parseQuery(c, ListFilesQuerySchema);
    const before = query.before === undefined ? undefined : decodeCursor(query.before);
    // Один лишний ряд — признак следующей страницы.
    const rows = await deps.files.listOutputs(c.get('user').id, {
      limit: query.limit + 1,
      ...(before ? { before } : {}),
      ...(query.category ? { mimes: FILE_CATEGORIES[query.category] } : {}),
      ...(query.q ? { search: query.q } : {}),
    });
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    const response: FileListResponse = {
      files: page.map(toFileDto),
      nextCursor: rows.length > query.limit && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
    };
    return c.json(response);
  });

  /**
   * Удаление результата из Library: только владелец и только выходной файл (входной принадлежит истории задачи).
   * Сначала объект: удаление S3 идемпотентно, сбой — 500, запись на месте, повтор доделает.
   */
  app.delete('/api/files/:id', async c => {
    const file = await deps.files.get(c.req.param('id'));
    if (!file || file.userId !== c.get('user').id) throw new ApiError(404, 'not_found', 'file not found');
    if (file.kind !== 'output') throw new ApiError(409, 'conflict', 'only task results can be deleted');
    await deps.fileStore.delete(file.storageKey);
    await deps.files.deleteOutput(file.id);
    return c.body(null, 204);
  });

  /** Скачивание: только владелец; presigned GET отдаёт файл как вложение — html и svg не откроются в нашем домене. */
  app.get('/api/files/:id', async c => {
    const file = await deps.files.get(c.req.param('id'));
    if (!file || file.userId !== c.get('user').id) throw new ApiError(404, 'not_found', 'file not found');
    // Входной файл мог быть объявлен, но не загружен: ссылка на несуществующий объект вела бы на NoSuchKey.
    if (file.kind === 'input' && !(await deps.fileStore.exists(file.storageKey)))
      throw new ApiError(409, 'upload_incomplete', `${file.path} has not been uploaded yet`);
    const url = await deps.fileStore.presignGet(file.storageKey, { downloadName: baseName(file.path) });
    c.header('Cache-Control', 'no-store');
    return c.redirect(url, 302);
  });
}
