import { afterAll, beforeAll, expect, test } from 'bun:test';
import { DockerCli, DockerError } from '../src/docker-cli';
import { requireSandboxImage, SANDBOX_IMAGE } from './helpers';

const cli = new DockerCli();
const leftovers: string[] = [];

beforeAll(async () => {
  await requireSandboxImage();
});
afterAll(async () => {
  await Promise.all(leftovers.map(name => cli.run(['rm', '-f', name])));
});

test('run returns stdout bytes, stderr and exit code', async () => {
  const r = await cli.run(['run', '--rm', SANDBOX_IMAGE, 'bash', '-c', 'echo out; echo err >&2; exit 3']);
  expect(new TextDecoder().decode(r.stdout)).toBe('out\n');
  expect(r.stderr).toBe('err\n');
  expect(r.exitCode).toBe(3);
});

test('run passes stdin through, binary-safe', async () => {
  const bytes = new Uint8Array([0, 255, 10, 13, 1]);
  const r = await cli.run(['run', '--rm', '-i', SANDBOX_IMAGE, 'cat'], { stdin: bytes });
  expect([...r.stdout]).toEqual([0, 255, 10, 13, 1]);
});

test('ok returns trimmed stdout and throws DockerError on failure', async () => {
  expect(await cli.ok(['image', 'inspect', SANDBOX_IMAGE, '--format', '{{.Config.User}}'])).toBe('agent');
  let caught: unknown;
  try {
    await cli.ok(['inspect', `no-such-container-${crypto.randomUUID()}`]);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(DockerError);
  expect((caught as DockerError).exitCode).not.toBe(0);
  expect((caught as DockerError).stderr).toMatch(/no such/i);
});

test('timeoutMs kills a hanging docker client', async () => {
  const name = `agent-cli-timeout-${crypto.randomUUID().slice(0, 8)}`;
  leftovers.push(name);
  const started = Date.now();
  const r = await cli.run(['run', '--rm', '--name', name, SANDBOX_IMAGE, 'sleep', '30'], { timeoutMs: 1_500 });
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(r.exitCode).not.toBe(0);
});

test('maxOutputBytes stops collecting, kills the client and reports truncation', async () => {
  const name = `agent-cli-flood-${crypto.randomUUID().slice(0, 8)}`;
  leftovers.push(name);
  const started = Date.now();
  const r = await cli.run(['run', '--rm', '--name', name, SANDBOX_IMAGE, 'yes'], { maxOutputBytes: 64 * 1024 });
  expect(Date.now() - started).toBeLessThan(15_000);
  expect(r.truncated).toBe(true);
  expect(r.stdout.length).toBe(64 * 1024);
  expect(new TextDecoder().decode(r.stdout.slice(0, 4))).toBe('y\ny\n');
});

test('output within maxOutputBytes is returned whole and not truncated', async () => {
  const r = await cli.run(['run', '--rm', SANDBOX_IMAGE, 'bash', '-c', 'printf 12345; printf ab >&2'], {
    maxOutputBytes: 5,
  });
  expect(r.truncated).toBe(false);
  expect(new TextDecoder().decode(r.stdout)).toBe('12345');
  expect(r.stderr).toBe('ab');
  expect(r.exitCode).toBe(0);
});

test('stderr over maxOutputBytes is capped too', async () => {
  const name = `agent-cli-flood-${crypto.randomUUID().slice(0, 8)}`;
  leftovers.push(name);
  const r = await cli.run(['run', '--rm', '--name', name, SANDBOX_IMAGE, 'bash', '-c', 'yes >&2'], {
    maxOutputBytes: 1000,
  });
  expect(r.truncated).toBe(true);
  expect(r.stderr.length).toBe(1000);
});
