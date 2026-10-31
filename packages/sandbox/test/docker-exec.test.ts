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
  expect(r).toEqual({ stdout: 'hello\n', stderr: 'oops\n', exitCode: 7, timedOut: false, truncated: false });
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

const MiB = 1024 * 1024;

test('exec output is capped at 1 MiB per stream by default and flagged truncated', async () => {
  const r = await sandbox.exec("head -c 3145728 /dev/zero | tr '\\0' a", { timeoutMs: 30_000 });
  expect(r.truncated).toBe(true);
  expect(r.stdout.length).toBe(MiB);
  expect(r.stdout).toMatch(/^a+$/);
});

test('an endless writer is cut off quickly and does not keep running', async () => {
  const started = Date.now();
  const r = await sandbox.exec('yes', { timeoutMs: 60_000 });
  expect(Date.now() - started).toBeLessThan(15_000);
  expect(r.truncated).toBe(true);
  expect(r.stdout.length).toBe(MiB);
  let left = 'unknown';
  for (let i = 0; i < 20; i++) {
    left = (await sandbox.exec('pgrep -x yes || true', { timeoutMs: 5_000 })).stdout.trim();
    if (left === '') break;
    await Bun.sleep(250);
  }
  expect(left).toBe('');
}, 30_000);

test('readFile refuses files over 50 MiB by default', async () => {
  await sandbox.exec('head -c 52428801 /dev/zero > big.bin', { timeoutMs: 30_000 });
  let caught: unknown;
  try {
    await sandbox.readFile('big.bin');
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(SandboxError);
  expect((caught as SandboxError).code).toBe('file_too_large');
  expect((caught as SandboxError).message).toContain('big.bin');
  await sandbox.exec('rm big.bin', { timeoutMs: 10_000 });
}, 30_000);

test('a non-finite or non-positive timeoutMs falls back to the 120 s default', async () => {
  for (const timeoutMs of [Number.NaN, 0, -5, Number.POSITIVE_INFINITY]) {
    const r = await sandbox.exec('sleep 2; echo ok', { timeoutMs });
    expect({ timeoutMs, r }).toEqual({
      timeoutMs,
      r: { stdout: 'ok\n', stderr: '', exitCode: 0, timedOut: false, truncated: false },
    });
  }
}, 60_000);
