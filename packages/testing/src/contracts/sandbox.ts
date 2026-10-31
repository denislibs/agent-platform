import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { NotFoundError, SandboxError, type Sandbox, type SandboxErrorCode, type SandboxProvider } from '@agent/core';

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

export function sandboxContract(
  name: string,
  open: () => Promise<{ provider: SandboxProvider; close(): Promise<void> }>,
): void {
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
      ({ provider, close } = await open());
    });
    afterAll(async () => {
      await Promise.all(created.map(s => s.destroy().catch(() => {})));
      await close();
    });

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

    test('sandboxes are isolated from each other', async () => {
      const a = await fresh();
      const b = await fresh();
      await a.writeFile('secret.txt', 'a-only');
      await expectNotFound(b.readFile('secret.txt'), 'file', 'secret.txt');
    });
  });
}
