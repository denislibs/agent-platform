import { NotFoundError, type FileRecord } from '@agent/core';
import type { Config, TaskResponse } from '@agent/shared';
import type { ApiDeps } from '../deps';
import { findPreviewSite, previewContentType, previewRequestPath, resolvePreviewFile } from './site';
import { previewLabel, previewSigningKey, verifyPreviewLabel } from './token';

/** Имя хоста из заголовка Host: нижний регистр, без порта и завершающих точек. */
export function previewHostname(host: string): string {
  const lower = host.trim().toLowerCase();
  const name = lower.startsWith('[') ? lower.slice(0, lower.indexOf(']') + 1) : lower.split(':', 1)[0]!;
  return name.replace(/\.+$/, '');
}

/** Запрос пришёл на хост превью: на сам PREVIEW_HOST или под него. Домен с тем же окончанием (notpreview.test) не считается. */
export function isPreviewRequest(preview: { hostname: string }, host: string | undefined): boolean {
  if (!host) return false;
  const name = previewHostname(host);
  return name === preview.hostname || name.endsWith(`.${preview.hostname}`);
}

/** Адрес превью для карточки задачи: есть точка входа среди выданных файлов и превью включены; иначе null. */
export function taskPreview(
  config: Config,
  taskId: string,
  files: readonly FileRecord[],
  now: Date,
): TaskResponse['preview'] {
  if (!config.preview || !findPreviewSite(files)) return null;
  const label = previewLabel(taskId, now, previewSigningKey(config.preview, config.auth.secret));
  if (!label) return null;
  return { url: `${new URL(config.auth.baseUrl).protocol}//${label}.${config.preview.host}/` };
}

/** Заголовки каждого ответа хоста превью, в том числе 404. CSP разрешает сайту почти всё, кроме встраивания чужими и отправки форм. */
const baseHeaders = (appOrigin: string): Record<string, string> => ({
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-cache',
  'content-security-policy':
    "default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval' https:; " +
    `frame-ancestors ${appOrigin}; form-action 'none'; base-uri 'self'`,
});

/** If-None-Match сравнивается слабо (RFC 9110): nginx со сжатием превращает ETag в W/"…". */
function matchesEtag(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header.split(',').some(tag => {
    const value = tag.trim();
    return value === '*' || value.replace(/^W\//, '') === etag;
  });
}

/**
 * Единственный обработчик хоста превью (createApp отправляет сюда раньше охраны и маршрутов). Доступ несёт метка хоста;
 * cookie и другие заголовки авторизации не читаются. Любая неудача — один и тот же 404: и плохая подпись, и нет файла.
 */
export async function servePreview(deps: ApiDeps, req: Request): Promise<Response> {
  const { config } = deps;
  const preview = config.preview!;
  const base = baseHeaders(new URL(config.auth.baseUrl).origin);
  const notFound = () =>
    new Response('Not found', { status: 404, headers: { ...base, 'content-type': 'text/plain; charset=utf-8' } });

  if (req.method !== 'GET' && req.method !== 'HEAD') return notFound();
  const hostname = previewHostname(req.headers.get('host') ?? '');
  const label = hostname.slice(0, -`.${preview.hostname}`.length);
  const key = previewSigningKey(preview, config.auth.secret);
  const taskId = verifyPreviewLabel(label, deps.clock.now(), key);
  const path = previewRequestPath(req.url);
  if (!taskId || path === null) return notFound();

  // Файлы удаляются вместе с задачей: удалённая задача — это просто сайт без файлов.
  const site = findPreviewSite(await deps.files.listForTask(taskId, 'output'));
  const file = site && resolvePreviewFile(site, path);
  if (!file || file.size > config.api.uploadMaxBytes) return notFound();

  const etag = `"${file.id}-${file.createdAt.getTime()}"`;
  const headers = { ...base, 'content-type': previewContentType(file.path), etag };
  if (matchesEtag(req.headers.get('if-none-match'), etag)) return new Response(null, { status: 304, headers });
  if (req.method === 'HEAD') {
    return new Response(null, { headers: { ...headers, 'content-length': String(file.size) } });
  }
  try {
    const bytes = await deps.fileStore.getBytes(file.storageKey);
    return new Response(bytes as Uint8Array<ArrayBuffer>, { headers });
  } catch (err) {
    if (err instanceof NotFoundError) return notFound();
    throw err;
  }
}
