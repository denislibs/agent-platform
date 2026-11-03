import { NotFoundError, SandboxError, type FileEntry, type Sandbox } from '@agent/core';

/** Сколько путей показывать модели как подсказку. */
export const WORKSPACE_HINT_FILES = 200;
/** Ключ S3 ограничен 1024 байтами; с префиксом tasks/<id>/ путь должен быть заметно короче. */
const MAX_PATH_BYTES = 900;
const hasControlChars = (s: string) => [...s].some(ch => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);
/** Не результат работы: служебные папки агента, зависимости и кэши. dist/ не здесь: это собранное приложение. */
const SKIPPED_DIRS = new Set([
  '.tool-outputs',
  '.screenshots',
  'node_modules',
  '.git',
  '__pycache__',
  '.venv',
  'venv',
  '.cache',
  '.npm',
  '.vite',
  // Однозначные кэши сборки и менеджеров пакетов. build, target, vendor, env, coverage не здесь: это бывает результатом.
  '.next',
  '.nuxt',
  '.pnpm-store',
  '.yarn',
  '.gradle',
  '.tox',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.turbo',
  '.parcel-cache',
]);

export const isSkippedPath = (path: string) => path.split('/').some(segment => SKIPPED_DIRS.has(segment));

/** Путь файла из finish → относительный путь внутри /workspace; всё сомнительное — undefined. */
export function safeOutputPath(raw: string): string | undefined {
  const p = raw
    .trim()
    .replace(/^\/workspace\//, '')
    .replace(/^(\.\/)+/, '')
    .replace(/\/{2,}/g, '/');
  if (!p || p.startsWith('/')) return undefined;
  // Управляющие символы ломают запуск в Docker, длинные пути — ключ S3: такой файл пропускаем, а не роняем job.
  if (hasControlChars(p) || new TextEncoder().encode(p).length > MAX_PATH_BYTES) return undefined;
  if (p.split('/').some(seg => seg === '' || seg === '.' || seg === '..')) return undefined;
  if (isSkippedPath(p)) return undefined;
  return p;
}

/** Ошибка чтения папки (права, сбой ФС), а не отсутствие песочницы: такую папку обход пропускает или сообщает о ней. */
const isUnreadable = (err: unknown) => err instanceof SandboxError && err.code === 'fs_error';
const isVanished = (err: unknown) => err instanceof NotFoundError && err.entity === 'file';

/**
 * Файлы под root (относительно /workspace) без пропускаемых папок. Обход по одному уровню, а не list(root, 10):
 * в node_modules десятки тысяч записей.
 * Корень, которого нет, — NotFoundError от sandbox.list: решает вызывающий. Подпапка, пропавшая посреди обхода,
 * пропускается. Нечитаемая папка (корень или подпапка) — в onUnreadable, обход идёт дальше; без onUnreadable
 * ошибка пробрасывается. Пропавшая песочница (NotFoundError sandbox) пробрасывается всегда.
 */
export async function walkFiles(
  sandbox: Sandbox,
  root: string,
  limit = Number.POSITIVE_INFINITY,
  onUnreadable?: (dir: string) => void,
): Promise<string[]> {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0 && files.length < limit) {
    const dir = pending.shift()!;
    let entries: FileEntry[];
    try {
      entries = await sandbox.list(dir, 1);
    } catch (err) {
      if (dir !== root && isVanished(err)) continue;
      if (isUnreadable(err) && onUnreadable) {
        onUnreadable(dir);
        continue;
      }
      throw err;
    }
    for (const entry of entries) {
      if (isSkippedPath(entry.path)) continue;
      if (entry.type === 'dir') pending.push(entry.path);
      else files.push(entry.path);
    }
  }
  return files.slice(0, limit);
}

/**
 * Подсказка модели: файлы рабочей папки, которые можно выдать (то, что отклонит safeOutputPath, не предлагаем).
 * Только подсказка: нет или не читается любая папка, включая корень, — просто меньше путей, а не сбой.
 * Пропавшая песочница пробрасывается. truncated — список обрезан по WORKSPACE_HINT_FILES.
 */
export async function workspaceFileHint(sandbox: Sandbox): Promise<{ files: string[]; truncated: boolean }> {
  let walked: string[];
  try {
    // На один путь больше лимита: так видно, что есть и другие.
    walked = await walkFiles(sandbox, '.', WORKSPACE_HINT_FILES + 1, () => {});
  } catch (err) {
    if (isVanished(err)) return { files: [], truncated: false };
    throw err;
  }
  const files = walked.filter(path => safeOutputPath(path) === path);
  return { files: files.slice(0, WORKSPACE_HINT_FILES), truncated: walked.length > WORKSPACE_HINT_FILES };
}

/**
 * Подсказка модели: ранее выданные файлы, не больше WORKSPACE_HINT_FILES, как и список рабочей папки. Длинный список
 * раздул бы запрос к модели. Список идёт от старых к новым, поэтому остаются последние: их чаще правят дальше.
 * truncated — список обрезан.
 */
export function deliveredFilesHint(paths: readonly string[]): { files: string[]; truncated: boolean } {
  return { files: paths.slice(-WORKSPACE_HINT_FILES), truncated: paths.length > WORKSPACE_HINT_FILES };
}

/** Записи папки; нет папки или путь идёт сквозь файл — пусто. Пропавшая песочница не глотается. */
async function entriesOf(sandbox: Sandbox, dir: string): Promise<FileEntry[]> {
  try {
    return await sandbox.list(dir, 1);
  } catch (err) {
    if (isVanished(err) || isUnreadable(err)) return [];
    throw err;
  }
}

/** Текст ошибки для модели, если finish называет то, что нельзя выдать; иначе null. */
export async function finishFilesProblem(sandbox: Sandbox, files: readonly string[]): Promise<string | null> {
  const bad: string[] = [];
  const listed = new Map<string, FileEntry[]>();
  for (const raw of files) {
    const path = safeOutputPath(raw);
    if (!path) {
      bad.push(raw);
      continue;
    }
    const cut = path.lastIndexOf('/');
    const dir = cut < 0 ? '.' : path.slice(0, cut);
    let entries = listed.get(dir);
    if (!entries) {
      entries = await entriesOf(sandbox, dir);
      listed.set(dir, entries);
    }
    if (!entries.some(e => e.path === path && e.type === 'file')) bad.push(raw);
  }
  if (bad.length === 0) return null;
  const hint = await workspaceFileHint(sandbox);
  const cut = hint.truncated ? ` (the list is cut at ${WORKSPACE_HINT_FILES} files; more exist)` : '';
  return [
    `These files do not exist or cannot be delivered: ${bad.join(', ')}.`,
    `Files in the workspace: ${hint.files.join(', ') || 'none'}${cut}.`,
    'Name real file paths from this list (not folders), or call finish again with an empty file list.',
  ].join(' ');
}
