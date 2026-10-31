import { S3Client } from 'bun';
import type { FileStore } from '@agent/core';

export interface FileStoreConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export class S3FileStore implements FileStore {
  private readonly s3: S3Client;

  constructor(cfg: FileStoreConfig) {
    // Garage uses path-style addressing; that is the S3Client default.
    this.s3 = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      bucket: cfg.bucket,
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    });
  }

  async put(key: string, data: string | Uint8Array | Blob, contentType?: string): Promise<void> {
    await this.s3.write(key, data, contentType ? { type: contentType } : undefined);
  }

  async getBytes(key: string): Promise<Uint8Array> {
    return new Uint8Array(await this.s3.file(key).arrayBuffer());
  }

  getText(key: string): Promise<string> {
    return this.s3.file(key).text();
  }

  exists(key: string): Promise<boolean> {
    return this.s3.file(key).exists();
  }

  async delete(key: string): Promise<void> {
    await this.s3.file(key).delete();
  }

  presignGet(key: string, expiresInSec = 900): string {
    return this.s3.presign(key, { method: 'GET', expiresIn: expiresInSec });
  }

  presignPut(key: string, contentType: string, expiresInSec = 900): string {
    return this.s3.presign(key, { method: 'PUT', expiresIn: expiresInSec, type: contentType });
  }
}
