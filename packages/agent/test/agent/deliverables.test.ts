import { describe, expect, test } from 'bun:test';
import { NotFoundError } from '@agent/core';
import { finishFilesProblem, isSkippedPath, safeOutputPath, walkFiles } from '../../src';
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
});

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
});
