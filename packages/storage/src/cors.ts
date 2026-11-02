import { GetBucketCorsCommand, PutBucketCorsCommand, S3Client, type CORSRule } from '@aws-sdk/client-s3';
import type { FileStoreConfig } from './index';

/** Правило CORS бакета для загрузок из браузера; остальные правила бакета не трогаются. */
export const BROWSER_UPLOADS_RULE_ID = 'browser-uploads';

async function currentRules(s3: S3Client, bucket: string): Promise<CORSRule[]> {
  try {
    return (await s3.send(new GetBucketCorsCommand({ Bucket: bucket }))).CORSRules ?? [];
  } catch (err) {
    // У бакета ещё нет CORS: S3 отвечает NoSuchCORSConfiguration.
    if (err instanceof Error && err.name === 'NoSuchCORSConfiguration') return [];
    throw err;
  }
}

/**
 * Разрешает браузеру с этих origin загружать файлы по presigned PUT (план 4a): preflight с Content-Type.
 * Origin добавляются к уже разрешённым (идемпотентно) — dev-стек, локальный Vite и e2e делят один бакет.
 * Возвращает итоговый список origin. Скачивание — переход по ссылке, CORS ему не нужен.
 */
export async function allowBrowserUploads(cfg: FileStoreConfig, origins: readonly string[]): Promise<string[]> {
  const s3 = new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    forcePathStyle: true,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  try {
    const rules = await currentRules(s3, cfg.bucket);
    const ours = rules.find(rule => rule.ID === BROWSER_UPLOADS_RULE_ID);
    const allowed = [...new Set([...(ours?.AllowedOrigins ?? []), ...origins.map(o => new URL(o).origin)])].toSorted();
    const rule: CORSRule = {
      ID: BROWSER_UPLOADS_RULE_ID,
      AllowedOrigins: allowed,
      AllowedMethods: ['PUT'],
      AllowedHeaders: ['content-type'],
      MaxAgeSeconds: 3600,
    };
    await s3.send(
      new PutBucketCorsCommand({
        Bucket: cfg.bucket,
        CORSConfiguration: { CORSRules: [...rules.filter(r => r.ID !== BROWSER_UPLOADS_RULE_ID), rule] },
      }),
    );
    return allowed;
  } finally {
    s3.destroy();
  }
}
