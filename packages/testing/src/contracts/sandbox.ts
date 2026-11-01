import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import {
  NotFoundError,
  SandboxError,
  type ExecOptions,
  type ExecResult,
  type Sandbox,
  type SandboxErrorCode,
  type SandboxProvider,
} from '@agent/core';

async function expectSandboxError(promise: Promise<unknown>, code: SandboxErrorCode): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(SandboxError);
  expect((caught as SandboxError).code).toBe(code);
}

async function expectNotFound(promise: Promise<unknown>, entity: string, key: string): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(NotFoundError);
  expect((caught as NotFoundError).entity).toBe(entity);
  expect((caught as NotFoundError).key).toBe(key);
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** Лимиты, с которыми контракт просит открыть провайдер: маленькие, чтобы проверить обрезку дёшево. */
export interface SandboxContractLimits {
  maxExecOutputBytes: number;
  maxReadFileBytes: number;
}
export const SANDBOX_CONTRACT_LIMITS: SandboxContractLimits = { maxExecOutputBytes: 4096, maxReadFileBytes: 8192 };

const FLOOD = /^head -c (\d+) \/dev\/zero \| tr '\\0' (\w)( >&2)?$/;
const flood = (bytes: number, char: string, toStderr = false) =>
  `head -c ${bytes} /dev/zero | tr '\\0' ${char}${toStderr ? ' >&2' : ''}`;

/**
 * Обработчик exec для двойника: понимает ровно те команды, которые запускает контракт, — так одни и те же
 * проверки идут и против настоящего bash, и против памяти. Обрезку по лимиту делает сам двойник.
 */
export function contractExecHandler(cmd: string, _opts: ExecOptions): Omit<ExecResult, 'truncated'> {
  if (cmd === 'echo contract-ok') return { stdout: 'contract-ok\n', stderr: '', exitCode: 0, timedOut: false };
  const m = FLOOD.exec(cmd);
  if (m) {
    const out = (m[2] ?? 'x').repeat(Number(m[1]));
    return m[3]
      ? { stdout: '', stderr: out, exitCode: 0, timedOut: false }
      : { stdout: out, stderr: '', exitCode: 0, timedOut: false };
  }
  return { stdout: '', stderr: `contract handler does not know: ${cmd}`, exitCode: 127, timedOut: false };
}

export function sandboxContract(
  name: string,
  open: (limits: SandboxContractLimits) => Promise<{ provider: SandboxProvider; close(): Promise<void> }>,
): void {
  // Тесты жизненного цикла на настоящих контейнерах (create, stop/start, destroy) идут 2–3 с, а под нагрузкой
  // полного прогона упираются в 5 с по умолчанию. Действует на файл, который запускает контракт.
  setDefaultTimeout(30_000);
  describe(`sandbox contract: ${name}`, () => {
    let provider: SandboxProvider;
    let close: () => Promise<void>;
    const created: Sandbox[] = [];
    const fresh = async (taskId: string = crypto.randomUUID()) => {
      const s = await provider.create(taskId);
      created.push(s);
      return s;
    };

    beforeAll(async () => {
      ({ provider, close } = await open(SANDBOX_CONTRACT_LIMITS));
    });
    // Параллельная уборка двух десятков настоящих контейнеров под нагрузкой не укладывается в 5 с по умолчанию.
    afterAll(async () => {
      await Promise.all(created.map(s => s.destroy().catch(() => {})));
      await close();
    }, 60_000);

    test('create is idempotent per task; get and list find the sandbox', async () => {
      const taskId = crypto.randomUUID();
      const a = await fresh(taskId);
      await a.writeFile('marker.txt', 'x');
      const b = await fresh(taskId);
      expect(a.id).toBe(`agent-sbx-${taskId}`);
      expect(b.id).toBe(a.id);
      expect(b.taskId).toBe(taskId);
      expect(text(await b.readFile('marker.txt'))).toBe('x');
      expect((await provider.get(a.id))?.taskId).toBe(taskId);
      expect((await provider.list()).find(i => i.id === a.id)).toEqual({ id: a.id, taskId, running: true });
    });

    test('get returns undefined for an unknown id', async () => {
      expect(await provider.get(`agent-sbx-${crypto.randomUUID()}`)).toBeUndefined();
      expect(await provider.get('not-a-sandbox')).toBeUndefined();
    });

    test('write and read text and binary files by relative and absolute paths', async () => {
      const s = await fresh();
      await s.writeFile('notes.txt', 'hello');
      await s.writeFile('/workspace/bin/data.bin', new Uint8Array([0, 255, 1, 254]));
      expect(text(await s.readFile('/workspace/notes.txt'))).toBe('hello');
      expect([...(await s.readFile('bin/data.bin'))]).toEqual([0, 255, 1, 254]);
    });

    test('writeFile creates parent folders and overwrites', async () => {
      const s = await fresh();
      await s.writeFile('outputs/deep/nested/r.csv', 'v1');
      await s.writeFile('outputs/deep/nested/r.csv', 'v2');
      expect(text(await s.readFile('outputs/deep/nested/r.csv'))).toBe('v2');
    });

    test('reading a missing file throws NotFoundError(file)', async () => {
      const s = await fresh();
      await expectNotFound(s.readFile('missing.txt'), 'file', 'missing.txt');
    });

    test('paths outside /workspace are rejected', async () => {
      const s = await fresh();
      await expectSandboxError(s.readFile('/etc/passwd'), 'path_outside_workspace');
      await expectSandboxError(s.writeFile('../escape.txt', 'x'), 'path_outside_workspace');
      await expectSandboxError(s.list('/', 1), 'path_outside_workspace');
      await expectSandboxError(s.exec('pwd', { timeoutMs: 5_000, cwd: '/tmp' }), 'path_outside_workspace');
      await expectSandboxError(s.readFile('/workspace-evil/x'), 'path_outside_workspace');
      await expectSandboxError(s.writeFile('a/../../x', 'x'), 'path_outside_workspace');
    });

    test('path errors win over sandbox state', async () => {
      const s = await fresh();
      await s.stop();
      await expectSandboxError(s.readFile('/etc/passwd'), 'path_outside_workspace');
    });

    test('a fresh sandbox lists as empty', async () => {
      const s = await fresh();
      expect(await s.list('', 1)).toEqual([]);
    });

    test('listing a path that is a file returns an empty list', async () => {
      const s = await fresh();
      await s.writeFile('only.txt', 'x');
      expect(await s.list('only.txt', 1)).toEqual([]);
    });

    test('list returns workspace-relative entries up to depth, sorted by path', async () => {
      const s = await fresh();
      await s.writeFile('a/b.txt', 'bbb');
      await s.writeFile('a/c/d.txt', 'dd');
      await s.writeFile('e.txt', 'eeeee');
      expect(await s.list('', 1)).toEqual([
        { path: 'a', type: 'dir', size: 0 },
        { path: 'e.txt', type: 'file', size: 5 },
      ]);
      expect(await s.list('', 3)).toEqual([
        { path: 'a', type: 'dir', size: 0 },
        { path: 'a/b.txt', type: 'file', size: 3 },
        { path: 'a/c', type: 'dir', size: 0 },
        { path: 'a/c/d.txt', type: 'file', size: 2 },
        { path: 'e.txt', type: 'file', size: 5 },
      ]);
      expect(await s.list('/workspace/a', 1)).toEqual([
        { path: 'a/b.txt', type: 'file', size: 3 },
        { path: 'a/c', type: 'dir', size: 0 },
      ]);
    });

    test('list handles names with tabs and newlines', async () => {
      const s = await fresh();
      await s.writeFile('dir/tab\there.txt', 'a');
      await s.writeFile('dir/new\nline.txt', 'bb');
      const expected = [
        { path: 'dir/tab\there.txt', type: 'file' as const, size: 1 },
        { path: 'dir/new\nline.txt', type: 'file' as const, size: 2 },
      ].toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      expect(await s.list('dir', 1)).toEqual(expected);
      expect(text(await s.readFile('dir/tab\there.txt'))).toBe('a');
      expect(text(await s.readFile('dir/new\nline.txt'))).toBe('bb');
    });

    test('listing a missing folder throws NotFoundError(file)', async () => {
      const s = await fresh();
      await expectNotFound(s.list('nope', 1), 'file', 'nope');
    });

    test('files survive stop/start; a stopped sandbox rejects operations', async () => {
      const s = await fresh();
      await s.writeFile('keep.txt', 'kept');
      await s.stop();
      expect((await provider.list()).find(i => i.id === s.id)?.running).toBe(false);
      await expectSandboxError(s.readFile('keep.txt'), 'not_running');
      await s.start();
      expect(text(await s.readFile('keep.txt'))).toBe('kept');
      const again = await provider.create(s.taskId);
      expect(again.id).toBe(s.id);
    });

    test('a stopped sandbox rejects every operation with not_running', async () => {
      const s = await fresh();
      await s.stop();
      await expectSandboxError(s.exec('true', { timeoutMs: 5_000 }), 'not_running');
      await expectSandboxError(s.readFile('x'), 'not_running');
      await expectSandboxError(s.writeFile('x', 'y'), 'not_running');
      await expectSandboxError(s.list('', 1), 'not_running');
    });

    test('a destroyed sandbox rejects every operation with NotFoundError(sandbox)', async () => {
      const s = await fresh();
      await s.destroy();
      await expectNotFound(s.exec('true', { timeoutMs: 5_000 }), 'sandbox', s.id);
      await expectNotFound(s.readFile('x'), 'sandbox', s.id);
      await expectNotFound(s.writeFile('x', 'y'), 'sandbox', s.id);
      await expectNotFound(s.list('', 1), 'sandbox', s.id);
    });

    test('destroying a stale handle does not touch a reborn sandbox', async () => {
      const taskId = crypto.randomUUID();
      const old = await fresh(taskId);
      await old.destroy();
      const reborn = await fresh(taskId);
      await old.destroy();
      expect((await provider.get(reborn.id))?.taskId).toBe(taskId);
      await reborn.writeFile('alive.txt', 'yes');
      expect(text(await reborn.readFile('alive.txt'))).toBe('yes');
    });

    test('create starts a stopped sandbox of the same task', async () => {
      const s = await fresh();
      await s.stop();
      const again = await provider.create(s.taskId);
      expect((await provider.list()).find(i => i.id === s.id)?.running).toBe(true);
      await again.writeFile('ok.txt', 'ok');
    });

    test('destroy removes the sandbox and its files', async () => {
      const taskId = crypto.randomUUID();
      const s = await fresh(taskId);
      await s.writeFile('gone.txt', 'x');
      await s.destroy();
      await s.destroy();
      expect(await provider.get(s.id)).toBeUndefined();
      expect((await provider.list()).some(i => i.id === s.id)).toBe(false);
      await expectNotFound(s.readFile('gone.txt'), 'sandbox', s.id);
      const reborn = await fresh(taskId);
      await expectNotFound(reborn.readFile('gone.txt'), 'file', 'gone.txt');
    });

    test('exec returns complete output with truncated false', async () => {
      const s = await fresh();
      expect(await s.exec('echo contract-ok', { timeoutMs: 10_000 })).toEqual({
        stdout: 'contract-ok\n',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        truncated: false,
      });
    });

    test('exec output over the limit is cut to the limit and flagged truncated', async () => {
      const s = await fresh();
      const limit = SANDBOX_CONTRACT_LIMITS.maxExecOutputBytes;
      const exact = await s.exec(flood(limit, 'x'), { timeoutMs: 10_000 });
      expect(exact).toMatchObject({ truncated: false, stdout: 'x'.repeat(limit) });
      const out = await s.exec(flood(limit * 5, 'x'), { timeoutMs: 10_000 });
      expect(out.truncated).toBe(true);
      expect(out.stdout).toBe('x'.repeat(limit));
      const err = await s.exec(flood(limit * 5, 'y', true), { timeoutMs: 10_000 });
      expect(err.truncated).toBe(true);
      expect(err.stderr).toBe('y'.repeat(limit));
    });

    test('readFile refuses a file over the limit with file_too_large', async () => {
      const s = await fresh();
      const limit = SANDBOX_CONTRACT_LIMITS.maxReadFileBytes;
      await s.writeFile('fits.bin', new Uint8Array(limit).fill(7));
      expect((await s.readFile('fits.bin')).length).toBe(limit);
      await s.writeFile('big.bin', new Uint8Array(limit + 1).fill(7));
      await expectSandboxError(s.readFile('big.bin'), 'file_too_large');
    });

    test('readFile on a folder throws not_a_file', async () => {
      const s = await fresh();
      await s.writeFile('dir/inner.txt', 'x');
      await expectSandboxError(s.readFile('dir'), 'not_a_file');
    });

    test('writeFile onto a folder throws fs_error and leaves the folder intact', async () => {
      const s = await fresh();
      await s.writeFile('d/inner.txt', 'x');
      await expectSandboxError(s.writeFile('d', 'y'), 'fs_error');
      expect(text(await s.readFile('d/inner.txt'))).toBe('x');
    });

    test('writeFile, readFile and list through a file throw fs_error naming the relative path', async () => {
      const s = await fresh();
      await s.writeFile('a.txt', 'x');
      await expectSandboxError(s.writeFile('a.txt/b', 'y'), 'fs_error');
      await expectSandboxError(s.readFile('a.txt/b'), 'fs_error');
      await expectSandboxError(s.list('a.txt/b', 1), 'fs_error');
      await expect(s.readFile('a.txt/b')).rejects.toThrow('a.txt/b');
      expect(text(await s.readFile('a.txt'))).toBe('x');
    });

    test('exec in a missing cwd throws NotFoundError(file) with the relative path', async () => {
      const s = await fresh();
      await expectNotFound(s.exec('echo contract-ok', { timeoutMs: 5000, cwd: 'no/such/dir' }), 'file', 'no/such/dir');
    });

    test('list with depth below 1 behaves like depth 1', async () => {
      const s = await fresh();
      await s.writeFile('a/b.txt', 'x');
      expect(await s.list('.', 0)).toEqual(await s.list('.', 1));
    });

    test('stop of a stopped and start of a running sandbox are not errors', async () => {
      const s = await fresh();
      await s.start();
      await s.stop();
      await s.stop();
      await s.start();
      await s.writeFile('ok.txt', 'ok');
      expect(text(await s.readFile('ok.txt'))).toBe('ok');
    });

    test('sandboxes are isolated from each other', async () => {
      const a = await fresh();
      const b = await fresh();
      await a.writeFile('secret.txt', 'a-only');
      await expectNotFound(b.readFile('secret.txt'), 'file', 'secret.txt');
    });
  });
}
