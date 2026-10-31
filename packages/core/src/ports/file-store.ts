/** Ключи: входные файлы inputs/<userId>/<fileId>/<name>, результаты tasks/<taskId>/<path>. */
export interface FileStore {
  put(key: string, data: string | Uint8Array | Blob, contentType?: string): Promise<void>;
  getBytes(key: string): Promise<Uint8Array>;
  getText(key: string): Promise<string>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  presignGet(key: string, expiresInSec?: number): string;
  presignPut(key: string, contentType: string, expiresInSec?: number): string;
}
