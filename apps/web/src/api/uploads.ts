import type { FileDto } from '@agent/shared';
import { ApiRequestError, type Api } from './client.ts';

/** Формат contentType, который принимает POST /api/uploads: тип без параметров. */
const MIME = /^[\w.+-]+\/[\w.+-]+$/;

/** Тип для подписи: из File.type без параметров; пустой или странный — application/octet-stream. */
export function uploadContentType(file: Pick<File, 'type'>): string {
  const type = file.type.split(';')[0]!.trim().toLowerCase();
  return type.length <= 127 && MIME.test(type) ? type : 'application/octet-stream';
}

export type PutFn = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Загрузка входного файла: объявить (POST /api/uploads) → PUT прямо в S3 по presigned URL → FileDto для fileIds.
 * Подпись S3 включает Content-Type и Content-Length: тип — ровно из ответа API, длину браузер ставит сам по File.
 */
export async function uploadFile(api: Api, file: File, put: PutFn = (url, init) => fetch(url, init)): Promise<FileDto> {
  const declared = await api.declareUpload({ name: file.name, contentType: uploadContentType(file), size: file.size });
  let res: Response;
  try {
    res = await put(declared.upload.url, {
      method: declared.upload.method,
      headers: declared.upload.headers,
      body: file,
      // Чужой origin (S3): cookie и прочие учётные данные туда не нужны.
      credentials: 'omit',
    });
  } catch {
    throw new ApiRequestError(0, 'network', `Could not upload ${file.name}. Check your connection and try again.`);
  }
  if (!res.ok)
    throw new ApiRequestError(res.status, 'upload_failed', `The storage refused ${file.name} (HTTP ${res.status}).`);
  return declared.file;
}
