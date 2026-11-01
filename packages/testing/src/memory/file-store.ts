import { NotFoundError, type FileStore, type PresignGetOptions, type PresignPutOptions } from '@agent/core';

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

  async presignGet(key: string, opts: PresignGetOptions = {}): Promise<string> {
    const download = opts.downloadName === undefined ? '' : `&download=${encodeURIComponent(opts.downloadName)}`;
    return `memory://${key}?op=get&expires=${Math.min(opts.expiresInSec ?? 900, 3600)}${download}`;
  }

  async presignPut(key: string, opts: PresignPutOptions): Promise<string> {
    const type = encodeURIComponent(opts.contentType);
    return `memory://${key}?op=put&type=${type}&size=${opts.size}&expires=${Math.min(opts.expiresInSec ?? 900, 3600)}`;
  }
}
