import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MAX_EXEC_TIMEOUT_MS, SandboxError, type Sandbox } from '@agent/core';
import { loadConfig } from '@agent/shared';
import { DockerCli, DockerSandboxProvider, type CliResult, type RunOptions } from '../src';
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

test('a command printing a daemon-like error does not look like a missing sandbox', async () => {
  const r = await sandbox.exec("echo 'Error response from daemon: No such container: x' >&2; exit 1", {
    timeoutMs: 10_000,
  });
  expect(r.exitCode).toBe(1);
  expect(r.stderr).toContain('No such container');
});

/** Настоящий docker CLI, который запоминает аргументы и опции каждого вызова. */
class RecordingCli extends DockerCli {
  readonly calls: { args: string[]; opts: RunOptions | undefined }[] = [];
  override async run(args: string[], opts?: RunOptions): Promise<CliResult> {
    this.calls.push({ args, opts });
    return super.run(args, opts);
  }
}

describe('with a 4097-byte output limit and a recording CLI', () => {
  const cli = new RecordingCli();
  let small: Sandbox;
  beforeAll(async () => {
    await requireSandboxImage();
    small = await new DockerSandboxProvider(loadConfig().sandbox, cli, { maxExecOutputBytes: 4097 }).create(
      crypto.randomUUID(),
    );
  });
  afterAll(async () => {
    await small?.destroy();
  });

  test('output cut inside a multi-byte character does not end with U+FFFD', async () => {
    // 'я' — 2 байта; 4097 байт режут символ пополам.
    const r = await small.exec("python3 -c \"print('я' * 5000, end='')\"", { timeoutMs: 20_000 });
    expect(r.truncated).toBe(true);
    expect(r.stdout.endsWith('\uFFFD')).toBe(false);
    expect(r.stdout).toBe('я'.repeat(2048));
  });

  test('stderr cut inside a multi-byte character does not end with U+FFFD either', async () => {
    const r = await small.exec('python3 -c "import sys; sys.stderr.write(\'я\' * 5000)"', { timeoutMs: 20_000 });
    expect(r.truncated).toBe(true);
    expect(r.stderr).toBe('я'.repeat(2048));
  });

  test('a timeoutMs above 30 minutes is capped at MAX_EXEC_TIMEOUT_MS', async () => {
    const cmd = `true # cap-${crypto.randomUUID()}`;
    const r = await small.exec(cmd, { timeoutMs: 10 * 60 * 60 * 1000 });
    expect(r.exitCode).toBe(0);
    const call = cli.calls.find(c => c.args.at(-1) === cmd);
    const pidFileAt = call?.args.findIndex(a => a.startsWith('/tmp/.agent-exec-')) ?? -1;
    // Аргумент обёртки после pid-файла — секунды для `timeout`; клиенту docker даётся ещё 15 с запаса.
    expect(call?.args[pidFileAt + 1]).toBe(String(MAX_EXEC_TIMEOUT_MS / 1000));
    expect(call?.opts?.timeoutMs).toBe(MAX_EXEC_TIMEOUT_MS + 15_000);
  });
});

test('a paused sandbox still rejects exec with not_running', async () => {
  const cli = new DockerCli();
  await cli.ok(['pause', sandbox.id]);
  let caught: unknown;
  try {
    await sandbox.exec('true', { timeoutMs: 5_000 });
  } catch (err) {
    caught = err;
  } finally {
    await cli.ok(['unpause', sandbox.id]);
  }
  expect(caught).toBeInstanceOf(SandboxError);
  expect((caught as SandboxError).code).toBe('not_running');
});
