import { NotFoundError, type FileStore } from '@agent/core';

export class InMemoryFileStore implements FileStore {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType?: string | undefined }>();

  async put(key: string, data: string | Uint8Array | Blob, contentType?: string): Promise<void> {
    const bytes =
      typeof data === 'string'
        ? new TextEncoder().encode(data)
        : data instanceof Blob
          ? new Uint8Array(await data.arrayBuffer())
          : new Uint8Array(data);
    this.objects.set(key, { bytes, contentType });
  }

  async getBytes(key: string): Promise<Uint8Array> {
    const o = this.objects.get(key);
    if (!o) throw new NotFoundError('object', key);
    return new Uint8Array(o.bytes);
  }

  async getText(key: string): Promise<string> {
    return new TextDecoder().decode(await this.getBytes(key));
  }

  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  presignGet(key: string, expiresInSec = 900): string {
    return `memory://${key}?op=get&expires=${expiresInSec}`;
  }

  presignPut(key: string, contentType: string, expiresInSec = 900): string {
    return `memory://${key}?op=put&type=${encodeURIComponent(contentType)}&expires=${expiresInSec}`;
  }
}
