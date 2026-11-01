export interface PresignGetOptions {
  /**
   * Имя файла в Content-Disposition. Скачивание всегда идёт как attachment (браузер не открывает файл в нашем
   * домене); без имени подставляется `download`.
   */
  downloadName?: string;
  /** Срок жизни, секунды: по умолчанию 900, не больше 3600. */
  expiresInSec?: number;
}

export interface PresignPutOptions {
  contentType: string;
  /** Подпись включает Content-Length: тело другой длины S3 отвергнет. Content-Type тоже подписан. */
  size: number;
  /** Срок жизни, секунды: по умолчанию 900, не больше 3600. */
  expiresInSec?: number;
}

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
  /** URL для браузера (публичный адрес хранилища); скачивание всегда как вложение. */
  presignGet(key: string, opts?: PresignGetOptions): Promise<string>;
  /** URL для загрузки браузером ровно opts.size байт. */
  presignPut(key: string, opts: PresignPutOptions): Promise<string>;
}
