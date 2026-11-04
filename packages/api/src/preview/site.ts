import type { FileRecord } from '@agent/core';

/**
 * Где искать точку входа сайта. Сначала outputs/ — то, что просит промпт (outputs/dist/index.html) и что агент отдаёт в
 * finish; корень рабочей папки в конце: там чаще исходный index.html Vite, который статикой не откроется, и устаревшая
 * копия dist/ не должна перекрывать полную копию под outputs/.
 */
const ENTRY_PATHS = [
  'outputs/dist/index.html',
  'outputs/build/index.html',
  'outputs/index.html',
  'dist/index.html',
  'build/index.html',
  'index.html',
];
const ENTRY_NAME = 'index.html';

/** Map, а не объект: `x.constructor` не должен находить унаследованное свойство Object. */
const CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
  ['html', 'text/html; charset=utf-8'],
  ['htm', 'text/html; charset=utf-8'],
  ['js', 'text/javascript; charset=utf-8'],
  ['mjs', 'text/javascript; charset=utf-8'],
  ['css', 'text/css; charset=utf-8'],
  ['json', 'application/json'],
  ['svg', 'image/svg+xml'],
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['avif', 'image/avif'],
  ['ico', 'image/x-icon'],
  ['woff', 'font/woff'],
  ['woff2', 'font/woff2'],
  ['ttf', 'font/ttf'],
  ['otf', 'font/otf'],
  ['wasm', 'application/wasm'],
  ['map', 'application/json'],
  ['txt', 'text/plain; charset=utf-8'],
  ['xml', 'application/xml'],
  ['mp4', 'video/mp4'],
  ['webm', 'video/webm'],
  ['mp3', 'audio/mpeg'],
  ['pdf', 'application/pdf'],
]);

/** Тип по расширению. Сохранённому mime верить нельзя: mimeOf финализатора пишет octet-stream для .js. */
export function previewContentType(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return (dot > 0 && CONTENT_TYPES.get(name.slice(dot + 1).toLowerCase())) || 'application/octet-stream';
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
  // Известных путей нет: единственный самый мелкий index.html под outputs/ (outputs/site/index.html). Два на одной
  // глубине — угадывать нельзя, превью нет.
  let shallowest: FileRecord[] = [];
  let depth = Infinity;
  for (const file of outputs.values()) {
    if (!file.path.startsWith('outputs/') || !file.path.endsWith(`/${ENTRY_NAME}`)) continue;
    const d = file.path.split('/').length;
    if (d < depth) [depth, shallowest] = [d, [file]];
    else if (d === depth) shallowest.push(file);
  }
  const [entry] = shallowest;
  return entry && shallowest.length === 1
    ? { entry, root: entry.path.slice(0, -ENTRY_NAME.length), files: outputs }
    : null;
}

/**
 * Путь запроса без начальной косой, декодированный один раз, или null, если форма запрещена: «..» и «.», пустые сегменты,
 * обратная косая, NUL, закодированная косая. Bun уже нормализует адрес запроса, поэтому защита от «..» держится не на
 * этом разборе, а на точном поиске файла под корнем сайта (resolvePreviewFile); отказ здесь — второй слой для сырого адреса.
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
 * Файл для пути: точное совпадение под корнем сайта. Путь без расширения может быть папкой со своим index.html
 * (/about и /about/ — about/index.html). Неизвестный путь без расширения — точка входа (маршрутизация на клиенте),
 * с расширением или под api/ — нет файла.
 */
export function resolvePreviewFile(site: PreviewSite, path: string): FileRecord | null {
  if (path === '') return site.entry;
  const file = site.files.get(site.root + path);
  if (file) return file;
  const index = !hasExtension(path) && site.files.get(`${site.root}${path}/${ENTRY_NAME}`);
  if (index) return index;
  return hasExtension(path) || isApiPath(path) ? null : site.entry;
}
