import { afterAll, beforeAll, expect, test } from 'bun:test';
import { SandboxError, type Sandbox } from '@agent/core';
import { loadConfig } from '@agent/shared';
import { DockerSandboxProvider } from '../src';
import { requireSandboxImage } from './helpers';

let sandbox: Sandbox;
beforeAll(async () => {
  await requireSandboxImage();
  sandbox = await new DockerSandboxProvider(loadConfig().sandbox).create(crypto.randomUUID());
});
afterAll(async () => {
  await sandbox?.destroy();
});

test('exec returns stdout, stderr and the exit code', async () => {
  const r = await sandbox.exec('echo hello; echo oops >&2; exit 7', { timeoutMs: 10_000 });
  expect(r).toEqual({ stdout: 'hello\n', stderr: 'oops\n', exitCode: 7, timedOut: false });
});

test('exec runs in /workspace by default and in a workspace subfolder on request', async () => {
  await sandbox.writeFile('sub/f.txt', 'x');
  expect((await sandbox.exec('pwd', { timeoutMs: 10_000 })).stdout).toBe('/workspace\n');
  expect((await sandbox.exec('pwd && ls', { timeoutMs: 10_000, cwd: 'sub' })).stdout).toBe('/workspace/sub\nf.txt\n');
});

test('exec passes stdin to the command', async () => {
  expect((await sandbox.exec('wc -c', { timeoutMs: 10_000, stdin: 'abcde' })).stdout.trim()).toBe('5');
});

test('files written by commands are visible through the file API and vice versa', async () => {
  await sandbox.exec('mkdir -p out && printf "a,b\\n1,2\\n" > out/r.csv', { timeoutMs: 10_000 });
  expect(new TextDecoder().decode(await sandbox.readFile('out/r.csv'))).toBe('a,b\n1,2\n');
  await sandbox.writeFile('in/data.txt', 'from api');
  expect((await sandbox.exec('cat in/data.txt', { timeoutMs: 10_000 })).stdout).toBe('from api');
});

test('exec is killed after timeoutMs and reports timedOut', async () => {
  const started = Date.now();
  const r = await sandbox.exec('sleep 30', { timeoutMs: 1_000 });
  expect(r.timedOut).toBe(true);
  expect(Date.now() - started).toBeLessThan(8_000);
});

test('exec with a cwd outside /workspace is rejected before running', async () => {
  let caught: unknown;
  try {
    await sandbox.exec('pwd', { timeoutMs: 1_000, cwd: '/etc' });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(SandboxError);
});
