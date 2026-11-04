import { NotFoundError, type FileRecord } from '@agent/core';
import type { Config, TaskResponse } from '@agent/shared';
import type { ApiDeps } from '../deps';
import { errorLogFields } from '../errors';
import { findPreviewSite, previewContentType, previewRequestPath, resolvePreviewFile } from './site';
import { previewLabel, previewSigningKey, verifyPreviewLabel } from './token';

/** Имя хоста из заголовка Host: нижний регистр, без порта и завершающих точек. */
export function previewHostname(host: string): string {
  const lower = host.trim().toLowerCase();
  const name = lower.startsWith('[') ? lower.slice(0, lower.indexOf(']') + 1) : lower.split(':', 1)[0]!;
  return name.replace(/\.+$/, '');
}

/** Заголовок Host нормальной формы: имя из ASCII или IPv6 в скобках, необязательный порт. Всё остальное — мусор или несколько значений. */
const WELL_FORMED_HOST = /^(?:[a-z0-9._-]+|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;

/** Запрос пришёл на хост превью: на сам PREVIEW_HOST или под него. Домен с тем же окончанием (notpreview.test) не считается. */
export function isPreviewRequest(preview: { hostname: string }, host: string | undefined): boolean {
  if (!host || !WELL_FORMED_HOST.test(host)) return false;
  const name = previewHostname(host);
  return name === preview.hostname || name.endsWith(`.${preview.hostname}`);
}

/**
 * Охрана изоляции: запрос идёт в обработчик превью, если Host — хост превью или кривой Host (два значения, скобка, не-ASCII),
 * где имя хоста превью упоминается. Без этого «preview, app» прошёл бы мимо проверки окончания к маршрутам приложения.
 * Нормальный чужой Host (app-preview.test) остаётся приложению: упоминание в имени само по себе ничего не значит.
 */
export function isPreviewGate(preview: { hostname: string }, host: string | undefined): boolean {
  if (!host) return false;
  if (isPreviewRequest(preview, host)) return true;
  return !WELL_FORMED_HOST.test(host) && host.toLowerCase().includes(preview.hostname);
}

/** Адрес превью для карточки задачи: есть точка входа среди выданных файлов и превью включены; иначе null. */
export function taskPreview(
  config: Config,
  taskId: string,
  files: readonly FileRecord[],
  now: Date,
): TaskResponse['preview'] {
  if (!config.preview) return null;
  // Карточка не обещает сайт, который хост откажется отдать: точка входа больше предела — нет превью.
  const site = findPreviewSite(files);
  if (!site || site.entry.size > config.api.uploadMaxBytes) return null;
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

/** Байты в полёте у ответов превью на один экземпляр API: ответ держит в памяти весь файл (до UPLOAD_MAX_BYTES), а nginx limit_req считает частоту, не одновременность. */
export const PREVIEW_INFLIGHT_BYTES = 256 * 1024 * 1024;

/** Бюджет байт: резерв берётся до чтения файла и возвращается ровно один раз. */
export class ByteBudget {
  private used = 0;
  constructor(private readonly capacity: number) {}

  /** Резерв размера или null, если не помещается; release возвращает его (повторный вызов ничего не делает). */
  reserve(bytes: number): (() => void) | null {
    if (this.used + bytes > this.capacity) return null;
    this.used += bytes;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.used -= bytes;
    };
  }
}

/**
 * Тело из байтов, которое возвращает резерв, когда оно прочитано целиком или клиент ушёл. Чанк один: следующий pull
 * приходит, только когда читатель забрал его, поэтому резерв живёт ровно пока байты ждут отправки.
 */
function reservedBody(bytes: Uint8Array, release: () => void): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(bytes);
        return;
      }
      controller.close();
      release();
    },
    cancel: release,
  });
}

/**
 * Единственный обработчик хоста превью (createApp отправляет сюда раньше охраны и маршрутов). Доступ несёт метка хоста;
 * cookie и другие заголовки авторизации не читаются. Любая неудача — один и тот же 404: и плохая подпись, и нет файла.
 * Сбой порта — обычный текстовый 500 с теми же заголовками (не конверт приложения), в журнал без имени хоста: он несёт доступ.
 */
export async function servePreview(deps: ApiDeps, req: Request, budget: ByteBudget): Promise<Response> {
  const base = baseHeaders(new URL(deps.config.auth.baseUrl).origin);
  try {
    return await servePreviewFile(deps, req, budget, base);
  } catch (err) {
    deps.logger.error('unhandled preview error', errorLogFields(err));
    return new Response('Internal error', {
      status: 500,
      headers: { ...base, 'content-type': 'text/plain; charset=utf-8' },
    });
  }
}

async function servePreviewFile(
  deps: ApiDeps,
  req: Request,
  budget: ByteBudget,
  base: Record<string, string>,
): Promise<Response> {
  const { config } = deps;
  const preview = config.preview!;
  const notFound = () =>
    new Response('Not found', { status: 404, headers: { ...base, 'content-type': 'text/plain; charset=utf-8' } });

  if (req.method !== 'GET' && req.method !== 'HEAD') return notFound();
  // Service worker сайта пережил бы метку: после её истечения он продолжал бы отдавать сайт из кеша.
  if (req.headers.get('service-worker')?.toLowerCase() === 'script') return notFound();
  const host = req.headers.get('host') ?? '';
  if (!isPreviewRequest(preview, host)) return notFound();
  const hostname = previewHostname(host);
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
  // Резерв до чтения: сколько бы запросов ни пришло, в памяти не больше PREVIEW_INFLIGHT_BYTES файлов.
  const release = budget.reserve(file.size);
  if (!release) {
    return new Response('Service unavailable', {
      status: 503,
      headers: { ...base, 'content-type': 'text/plain; charset=utf-8', 'retry-after': '5' },
    });
  }
  let bytes: Uint8Array;
  try {
    bytes = await deps.fileStore.getBytes(file.storageKey);
  } catch (err) {
    release();
    if (err instanceof NotFoundError) return notFound();
    throw err;
  }
  return new Response(reservedBody(bytes, release), {
    headers: { ...headers, 'content-length': String(bytes.byteLength) },
  });
}
