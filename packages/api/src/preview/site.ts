import type { FileRecord } from '@agent/core';

/** Где искать точку входа сайта: собранная папка раньше исходников, поэтому исходный index.html Vite не откроется. */
const ENTRY_PATHS = [
  'dist/index.html',
  'outputs/dist/index.html',
  'build/index.html',
  'outputs/build/index.html',
  'outputs/index.html',
  'index.html',
];
const ENTRY_NAME = 'index.html';

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  wasm: 'application/wasm',
  map: 'application/json',
  txt: 'text/plain; charset=utf-8',
  xml: 'application/xml',
};

/** Тип по расширению. Сохранённому mime верить нельзя: mimeOf финализатора пишет octet-stream для .js. */
export function previewContentType(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return (dot > 0 && CONTENT_TYPES[name.slice(dot + 1).toLowerCase()]) || 'application/octet-stream';
}

export interface PreviewSite {
  entry: FileRecord;
  /** Папка точки входа с косой на конце (или пусто): корень хоста превью. */
  root: string;
  /** Выданные файлы задачи по пути. */
  files: ReadonlyMap<string, FileRecord>;
}

/** Сайт среди файлов задачи: только результаты (kind output), входной файл сайтом не считается. Нет точки входа — null. */
export function findPreviewSite(files: readonly FileRecord[]): PreviewSite | null {
  const outputs = new Map(files.filter(f => f.kind === 'output').map(f => [f.path, f]));
  for (const path of ENTRY_PATHS) {
    const entry = outputs.get(path);
    if (entry) return { entry, root: path.slice(0, -ENTRY_NAME.length), files: outputs };
  }
  return null;
}

/**
 * Путь запроса без начальной косой, декодированный один раз, или null, если форма запрещена: «..» и «.», пустые сегменты,
 * обратная косая, NUL, закодированная косая. Берётся из сырого адреса: разбор через URL склеил бы «..» раньше проверки.
 */
export function previewRequestPath(url: string): string | null {
  const raw = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '').split(/[?#]/, 1)[0] ?? '';
  if (!raw.startsWith('/') || /%(?:2f|5c)/i.test(raw)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw.slice(1));
  } catch {
    return null;
  }
  if (decoded.includes('\\') || decoded.includes('\0')) return null;
  const segments = decoded.split('/');
  // Косая на конце (/about/) — маршрут сайта; пустым может быть только этот последний сегмент.
  if (segments.at(-1) === '') segments.pop();
  if (segments.some(s => s === '' || s === '.' || s === '..')) return null;
  return segments.join('/');
}

const hasExtension = (path: string) => /\.[^./]+$/.test(path);
/** Запрос к несуществующему API сайта не должен получить HTML: приложение ждёт JSON и упадёт непонятно. */
const isApiPath = (path: string) => path === 'api' || path.startsWith('api/');

/**
 * Файл для пути: точное совпадение под корнем сайта. Неизвестный путь без расширения — точка входа (маршрутизация на
 * клиенте), с расширением или под api/ — нет файла.
 */
export function resolvePreviewFile(site: PreviewSite, path: string): FileRecord | null {
  if (path === '') return site.entry;
  const file = site.files.get(site.root + path);
  if (file) return file;
  return hasExtension(path) || isApiPath(path) ? null : site.entry;
}
