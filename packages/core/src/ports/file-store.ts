export interface PresignGetOptions {
  /** Имя файла для Content-Disposition: attachment — браузер скачивает файл, а не открывает его в нашем домене. */
  downloadName?: string;
  expiresInSec?: number;
}

export interface PresignPutOptions {
  contentType: string;
  /** Подпись включает Content-Length: тело другой длины S3 отвергнет. */
  size: number;
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
  /** URL для браузера (публичный адрес хранилища); по умолчанию живёт 15 минут. */
  presignGet(key: string, opts?: PresignGetOptions): Promise<string>;
  /** URL для загрузки браузером ровно opts.size байт. */
  presignPut(key: string, opts: PresignPutOptions): Promise<string>;
}
