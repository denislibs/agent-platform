import { PutObjectCommand, S3Client as AwsS3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { S3Client, type S3File } from 'bun';
import { NotFoundError, type FileStore, type PresignGetOptions, type PresignPutOptions } from '@agent/core';

export interface FileStoreConfig {
  endpoint: string;
  /** Адрес хранилища, видимый браузеру; presigned URL подписываются на него. По умолчанию endpoint. */
  publicEndpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

const DEFAULT_EXPIRES_SEC = 900;

/** Content-Disposition вложения: ASCII-замена для старых клиентов и точное имя в filename* (RFC 6266/5987). */
export function attachmentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export class S3FileStore implements FileStore {
  private readonly s3: S3Client;
  /** Тот же бакет с публичным адресом: подпись GET считается для хоста, который увидит браузер. */
  private readonly publicS3: S3Client;
  /**
   * AWS SDK — только для presigned PUT: он подписывает Content-Length, а Bun presign подписывает лишь host.
   * WHEN_REQUIRED: с контрольными суммами по умолчанию Garage отвечает на такой PUT 400.
   */
  private readonly signer: AwsS3Client;
  private readonly bucket: string;

  constructor(cfg: FileStoreConfig) {
    const publicEndpoint = cfg.publicEndpoint ?? cfg.endpoint;
    const credentials = { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey };
    // Garage uses path-style addressing; that is the S3Client default.
    this.s3 = new S3Client({ endpoint: cfg.endpoint, region: cfg.region, bucket: cfg.bucket, ...credentials });
    this.publicS3 = new S3Client({ endpoint: publicEndpoint, region: cfg.region, bucket: cfg.bucket, ...credentials });
    this.signer = new AwsS3Client({
      endpoint: publicEndpoint,
      region: cfg.region,
      forcePathStyle: true,
      credentials,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
    this.bucket = cfg.bucket;
  }

  async put(key: string, data: string | Uint8Array | Blob, contentType?: string): Promise<void> {
    await this.s3.write(key, data, contentType ? { type: contentType } : undefined);
  }

  async getBytes(key: string): Promise<Uint8Array> {
    return new Uint8Array(await this.read(key, f => f.arrayBuffer()));
  }

  getText(key: string): Promise<string> {
    return this.read(key, f => f.text());
  }

  exists(key: string): Promise<boolean> {
    return this.s3.file(key).exists();
  }

  async delete(key: string): Promise<void> {
    await this.s3.file(key).delete();
  }

  /** Отсутствующий ключ — NotFoundError по контракту порта; остальные ошибки S3 пробрасываются как есть. */
  private async read<T>(key: string, fn: (file: S3File) => Promise<T>): Promise<T> {
    try {
      return await fn(this.s3.file(key));
    } catch (err) {
      if (isNoSuchKey(err)) throw new NotFoundError('object', key);
      throw err;
    }
  }

  async presignGet(key: string, opts: PresignGetOptions = {}): Promise<string> {
    return this.publicS3.presign(key, {
      method: 'GET',
      expiresIn: opts.expiresInSec ?? DEFAULT_EXPIRES_SEC,
      ...(opts.downloadName === undefined ? {} : { contentDisposition: attachmentDisposition(opts.downloadName) }),
    });
  }

  async presignPut(key: string, opts: PresignPutOptions): Promise<string> {
    if (!Number.isSafeInteger(opts.size) || opts.size <= 0)
      throw new RangeError(`size must be a positive integer, got ${opts.size}`);
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: opts.contentType,
      ContentLength: opts.size,
    });
    return getSignedUrl(this.signer, command, { expiresIn: opts.expiresInSec ?? DEFAULT_EXPIRES_SEC });
  }
}

function isNoSuchKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'NoSuchKey';
}
