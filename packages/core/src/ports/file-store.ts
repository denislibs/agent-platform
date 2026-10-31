/** Ключи: входные файлы inputs/<userId>/<fileId>/<name>, результаты tasks/<taskId>/<path>. */
export interface FileStore {
  put(key: string, data: string | Uint8Array | Blob, contentType?: string): Promise<void>;
  /** Отсутствующий ключ — NotFoundError('object', key). */
  getBytes(key: string): Promise<Uint8Array>;
  /** Отсутствующий ключ — NotFoundError('object', key). */
  getText(key: string): Promise<string>;
  exists(key: string): Promise<boolean>;
  /** Идемпотентно: удаление отсутствующего ключа не ошибка. */
  delete(key: string): Promise<void>;
  presignGet(key: string, expiresInSec?: number): string;
  presignPut(key: string, contentType: string, expiresInSec?: number): string;
}
