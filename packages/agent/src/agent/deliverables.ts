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

/**
 * Файлы под root (относительно /workspace) без пропускаемых папок. Обход по одному уровню, а не list(root, 10):
 * в node_modules десятки тысяч записей. Нет root — NotFoundError от sandbox.list.
 */
export async function walkFiles(sandbox: Sandbox, root: string, limit = Number.POSITIVE_INFINITY): Promise<string[]> {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0 && files.length < limit) {
    for (const entry of await sandbox.list(pending.shift()!, 1)) {
      if (isSkippedPath(entry.path)) continue;
      if (entry.type === 'dir') pending.push(entry.path);
      else files.push(entry.path);
    }
  }
  return files.slice(0, limit);
}

/** Записи папки; нет папки или путь идёт сквозь файл — пусто. Пропавшая песочница не глотается. */
async function entriesOf(sandbox: Sandbox, dir: string): Promise<FileEntry[]> {
  try {
    return await sandbox.list(dir, 1);
  } catch (err) {
    const absent =
      (err instanceof NotFoundError && err.entity === 'file') ||
      (err instanceof SandboxError && err.code === 'fs_error');
    if (absent) return [];
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
  const real = await walkFiles(sandbox, '.', WORKSPACE_HINT_FILES);
  return [
    `These files do not exist or cannot be delivered: ${bad.join(', ')}.`,
    `Files in the workspace: ${real.join(', ') || 'none'}.`,
    'Name real file paths (not folders), or copy the deliverables to outputs/, then call finish again.',
  ].join(' ');
}
