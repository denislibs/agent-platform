import { SandboxError } from './errors';

export const WORKSPACE_ROOT = '/workspace';

/** Верхний предел ExecOptions.timeoutMs (30 минут): больше — урезается. */
export const MAX_EXEC_TIMEOUT_MS = 1_800_000;

const outside = (path: string) =>
  new SandboxError('path_outside_workspace', `path "${path}" is outside ${WORKSPACE_ROOT}`);

/** Относительные пути — от /workspace; абсолютные — только внутри /workspace. Возвращает нормализованный абсолютный путь. */
export function resolveWorkspacePath(path: string): string {
  const raw = path.startsWith('/') ? path : `${WORKSPACE_ROOT}/${path}`;
  const segments: string[] = [];
  for (const segment of raw.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) throw outside(path);
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const abs = `/${segments.join('/')}`;
  if (abs !== WORKSPACE_ROOT && !abs.startsWith(`${WORKSPACE_ROOT}/`)) throw outside(path);
  return abs;
}

/** '/workspace/outputs/a.csv' → 'outputs/a.csv'; '/workspace' → ''. */
export function toWorkspaceRelative(abs: string): string {
  return abs === WORKSPACE_ROOT ? '' : abs.slice(WORKSPACE_ROOT.length + 1);
}
