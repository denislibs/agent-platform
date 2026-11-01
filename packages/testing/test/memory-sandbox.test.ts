import { expect, test } from 'bun:test';
import { MAX_EXEC_TIMEOUT_MS, SandboxError } from '@agent/core';
import { contractExecHandler, InMemorySandboxProvider, sandboxContract } from '@agent/testing';

sandboxContract('in-memory', async limits => ({
  provider: new InMemorySandboxProvider({ exec: contractExecHandler }, limits),
  close: async () => {},
}));

test('exec and browser delegate to scripted handlers with a resolved cwd', async () => {
  const provider = new InMemorySandboxProvider({
    exec: (cmd, opts) => ({ stdout: `${opts.cwd}$ ${cmd}`, stderr: '', exitCode: 0, timedOut: false }),
    browser: action => ({
      url: action.type === 'open' ? action.url : 'about:blank',
      title: 'T',
      markdown: '# T',
      truncated: false,
      elements: [],
      elementsTruncated: false,
    }),
  });
  const s = await provider.create(crypto.randomUUID());
  await s.writeFile('outputs/r.csv', 'a'); // cwd должен существовать
  expect((await s.exec('ls', { timeoutMs: 1000, cwd: 'outputs' })).stdout).toBe('/workspace/outputs$ ls');
  expect((await s.browser({ type: 'open', url: 'https://example.com' })).url).toBe('https://example.com');
});

test('without handlers exec returns 127 and browser fails clearly', async () => {
  const s = await new InMemorySandboxProvider().create(crypto.randomUUID());
  expect(await s.exec('ls', { timeoutMs: 1000 })).toMatchObject({ exitCode: 127, timedOut: false, truncated: false });
  let caught: unknown;
  try {
    await s.browser({ type: 'snapshot' });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(SandboxError);
  expect((caught as SandboxError).code).toBe('browser_failed');
});

test('the double caps exec output at 1 MiB per stream and readFile at 50 MiB by default', async () => {
  const provider = new InMemorySandboxProvider({
    exec: () => ({ stdout: 'a'.repeat(2 * 1024 * 1024), stderr: 'e', exitCode: 0, timedOut: false }),
  });
  const s = await provider.create(crypto.randomUUID());
  const r = await s.exec('flood', { timeoutMs: 1000 });
  expect(r.truncated).toBe(true);
  expect(r.stdout.length).toBe(1024 * 1024);
  expect(r.stderr).toBe('e');
  await s.writeFile('big.bin', new Uint8Array(50 * 1024 * 1024 + 1));
  let caught: unknown;
  try {
    await s.readFile('big.bin');
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(SandboxError);
  expect((caught as SandboxError).code).toBe('file_too_large');
});

test('a handler that reports truncated keeps the flag', async () => {
  const provider = new InMemorySandboxProvider({
    exec: () => ({ stdout: 'x', stderr: '', exitCode: 0, timedOut: false, truncated: true }),
  });
  const s = await provider.create(crypto.randomUUID());
  expect((await s.exec('x', { timeoutMs: 1000 })).truncated).toBe(true);
});

test('exec hands the handler a timeoutMs capped at MAX_EXEC_TIMEOUT_MS', async () => {
  const seen: number[] = [];
  const provider = new InMemorySandboxProvider({
    exec: (_cmd, opts) => {
      seen.push(opts.timeoutMs);
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
    },
  });
  const s = await provider.create(crypto.randomUUID());
  await s.exec('true', { timeoutMs: 10 * 60 * 60 * 1000 });
  await s.exec('true', { timeoutMs: 5_000 });
  expect(seen).toEqual([MAX_EXEC_TIMEOUT_MS, 5_000]);
});
