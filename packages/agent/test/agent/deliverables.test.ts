import { describe, expect, test } from 'bun:test';
import { NotFoundError, SandboxError, type Sandbox } from '@agent/core';
import {
  finishFilesProblem,
  isSkippedPath,
  safeOutputPath,
  walkFiles,
  WORKSPACE_HINT_FILES,
  workspaceFileHint,
} from '../../src';
import { planned, setupAgent } from './fixtures';

async function workspace(writes: Record<string, string>) {
  const c = setupAgent();
  const task = await planned(c);
  const sandbox = await c.sandboxes.create(task.id);
  for (const [path, body] of Object.entries(writes)) await sandbox.writeFile(path, body);
  return sandbox;
}

describe('isSkippedPath', () => {
  test('skips dependencies, caches and service folders at any depth, by whole segment', () => {
    for (const path of ['node_modules/a.js', 'outputs/node_modules/a.js', '.git/HEAD', 'x/__pycache__/a.pyc']) {
      expect(isSkippedPath(path)).toBe(true);
    }
    expect(isSkippedPath('.tool-outputs/1-0.txt')).toBe(true);
    for (const path of ['dist/assets/a.js', 'outputs/cache/a.txt', 'src/node_modules.md']) {
      expect(isSkippedPath(path)).toBe(false);
    }
  });

  test('skips unambiguous build caches but not folders that can be real deliverables', () => {
    for (const dir of [
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
    ]) {
      expect(isSkippedPath(`app/${dir}/x`)).toBe(true);
    }
    for (const dir of ['build', 'target', 'vendor', 'env', 'coverage']) {
      expect(isSkippedPath(`app/${dir}/x`)).toBe(false);
    }
  });
});

/** Песочница в памяти не умеет пропадающие и нечитаемые папки: подменяем list на нужных путях. */
function failListing(sandbox: Sandbox, failures: Record<string, Error>) {
  const real = sandbox.list.bind(sandbox);
  sandbox.list = async (path, depth) => {
    const failure = failures[path];
    if (failure) throw failure;
    return real(path, depth);
  };
}
const unreadable = (path: string) => new SandboxError('fs_error', `list ${path} failed: Permission denied`);

describe('safeOutputPath', () => {
  test('refuses skipped folders', () => {
    expect(safeOutputPath('outputs/node_modules/a.js')).toBeUndefined();
    expect(safeOutputPath('outputs/dist/a.js')).toBe('outputs/dist/a.js');
  });
});

describe('walkFiles', () => {
  test('returns files under the root and prunes skipped folders', async () => {
    const sandbox = await workspace({
      'README.md': 'r',
      'src/App.jsx': 'a',
      'dist/assets/a.js': 'd',
      'node_modules/x/index.js': 'n',
    });
    expect((await walkFiles(sandbox, '.')).toSorted()).toEqual(['README.md', 'dist/assets/a.js', 'src/App.jsx']);
  });

  test('stops at the limit', async () => {
    const sandbox = await workspace({ 'a.md': 'a', 'b.md': 'b', 'c.md': 'c' });
    expect(await walkFiles(sandbox, '.', 2)).toHaveLength(2);
  });

  test('a missing root is reported to the caller', async () => {
    const sandbox = await workspace({ 'a.md': 'a' });
    await expect(walkFiles(sandbox, 'outputs')).rejects.toBeInstanceOf(NotFoundError);
  });

  test('a subfolder that vanished mid-walk is skipped, the rest is returned', async () => {
    const sandbox = await workspace({ 'outputs/table.md': 't', 'outputs/build/a.js': 'a' });
    failListing(sandbox, { 'outputs/build': new NotFoundError('file', 'outputs/build') });
    expect(await walkFiles(sandbox, 'outputs')).toEqual(['outputs/table.md']);
  });

  test('a dead sandbox is never swallowed, at the root or deeper', async () => {
    for (const failing of ['outputs', 'outputs/build']) {
      const sandbox = await workspace({ 'outputs/table.md': 't', 'outputs/build/a.js': 'a' });
      failListing(sandbox, { [failing]: new NotFoundError('sandbox', 'gone') });
      const err = await walkFiles(sandbox, 'outputs').catch((e: unknown) => e);
      expect(err).toMatchObject({ entity: 'sandbox' });
    }
  });

  test('an unreadable folder is reported to the callback and the walk goes on', async () => {
    const sandbox = await workspace({ 'outputs/table.md': 't', 'outputs/locked/a.js': 'a' });
    failListing(sandbox, { 'outputs/locked': unreadable('outputs/locked') });
    const seen: string[] = [];
    expect(await walkFiles(sandbox, 'outputs', Number.POSITIVE_INFINITY, dir => seen.push(dir))).toEqual([
      'outputs/table.md',
    ]);
    expect(seen).toEqual(['outputs/locked']);
  });

  test('an unreadable root is reported to the callback; without a callback it is thrown', async () => {
    const sandbox = await workspace({ 'outputs/table.md': 't' });
    failListing(sandbox, { outputs: unreadable('outputs') });
    const seen: string[] = [];
    expect(await walkFiles(sandbox, 'outputs', Number.POSITIVE_INFINITY, dir => seen.push(dir))).toEqual([]);
    expect(seen).toEqual(['outputs']);
    await expect(walkFiles(sandbox, 'outputs')).rejects.toBeInstanceOf(SandboxError);
  });
});

describe('workspaceFileHint', () => {
  test('lists deliverable files and tolerates absent or unreadable folders at any level, root included', async () => {
    const sandbox = await workspace({ 'a.md': 'a', 'locked/x': 'x', 'gone/y': 'y' });
    failListing(sandbox, {
      locked: unreadable('locked'),
      gone: new NotFoundError('file', 'gone'),
    });
    expect(await workspaceFileHint(sandbox)).toEqual({ files: ['a.md'], truncated: false });
    failListing(sandbox, { '.': unreadable('.') });
    expect(await workspaceFileHint(sandbox)).toEqual({ files: [], truncated: false });
    failListing(sandbox, { '.': new NotFoundError('file', '.') });
    expect(await workspaceFileHint(sandbox)).toEqual({ files: [], truncated: false });
  });

  test('a dead sandbox is not swallowed', async () => {
    const sandbox = await workspace({ 'a.md': 'a' });
    failListing(sandbox, { '.': new NotFoundError('sandbox', 'gone') });
    await expect(workspaceFileHint(sandbox)).rejects.toMatchObject({ entity: 'sandbox' });
  });

  test('offers only paths that can be delivered', async () => {
    const sandbox = await workspace({ 'bad\nname.md': 'b', 'ok.md': 'o', 'node_modules/x.js': 'n' });
    expect((await workspaceFileHint(sandbox)).files).toEqual(['ok.md']);
  });

  test('says when the list is cut', async () => {
    const writes = Object.fromEntries(Array.from({ length: WORKSPACE_HINT_FILES + 1 }, (_, i) => [`f${i}.md`, 'x']));
    const hint = await workspaceFileHint(await workspace(writes));
    expect(hint.files).toHaveLength(WORKSPACE_HINT_FILES);
    expect(hint.truncated).toBe(true);
    const exact = await workspaceFileHint(
      await workspace(Object.fromEntries(Array.from({ length: WORKSPACE_HINT_FILES }, (_, i) => [`f${i}.md`, 'x']))),
    );
    expect(exact.truncated).toBe(false);
  });
});

describe('finishFilesProblem', () => {
  test('existing files pass, including workspace-absolute paths', async () => {
    const sandbox = await workspace({ 'src/App.jsx': 'a', 'README.md': 'r' });
    expect(await finishFilesProblem(sandbox, ['/workspace/src/App.jsx', './README.md'])).toBeNull();
    expect(await finishFilesProblem(sandbox, [])).toBeNull();
  });

  test('names what is wrong and lists the real files', async () => {
    const sandbox = await workspace({ 'src/App.jsx': 'a', 'node_modules/x/index.js': 'n' });
    const problem = await finishFilesProblem(sandbox, ['outputs/src/App.jsx', 'src/App.jsx']);
    expect(problem).toContain('outputs/src/App.jsx');
    expect(problem).toContain('Files in the workspace: src/App.jsx');
    expect(problem).not.toContain('node_modules');
  });

  test('folders, skipped folders and paths through a file are refused', async () => {
    const sandbox = await workspace({ 'dist/a.js': 'a', 'note.md': 'n', 'node_modules/x.js': 'x' });
    for (const bad of ['dist', 'node_modules/x.js', 'note.md/inner.txt', '../etc/passwd']) {
      expect(await finishFilesProblem(sandbox, [bad])).toContain(bad);
    }
  });

  test('tells the model how to correct the call with the tools it has', async () => {
    const sandbox = await workspace({ 'src/App.jsx': 'a' });
    const problem = await finishFilesProblem(sandbox, ['nope.md']);
    expect(problem).toContain('Files in the workspace: src/App.jsx');
    expect(problem).toContain('with an empty file list');
    expect(problem).not.toContain('copy');
  });

  test('says when the file list is cut', async () => {
    const writes = Object.fromEntries(Array.from({ length: WORKSPACE_HINT_FILES + 1 }, (_, i) => [`f${i}.md`, 'x']));
    const problem = await finishFilesProblem(await workspace(writes), ['nope.md']);
    expect(problem).toContain(`the list is cut at ${WORKSPACE_HINT_FILES}`);
  });

  test('an unreadable folder in the workspace does not break the check', async () => {
    const sandbox = await workspace({ 'a.md': 'a', 'locked/x': 'x' });
    failListing(sandbox, { locked: unreadable('locked') });
    const problem = await finishFilesProblem(sandbox, ['nope.md']);
    expect(problem).toContain('nope.md');
    expect(problem).toContain('Files in the workspace: a.md');
  });
});
