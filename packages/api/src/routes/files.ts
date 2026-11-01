import type { Hono } from 'hono';
import { UploadBodySchema, type UploadResponse } from '@agent/shared';
import type { ApiDeps, ApiEnv } from '../deps';
import { toFileDto } from '../dto';
import { ApiError } from '../errors';
import { baseName, safeFileName } from '../file-names';
import { parseJson } from '../http';

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
