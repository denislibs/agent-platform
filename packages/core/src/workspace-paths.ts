import { SandboxError } from './errors';

export const WORKSPACE_ROOT = '/workspace';

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
