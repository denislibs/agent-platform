import { expect, test } from 'bun:test';
import { SandboxError } from '@agent/core';
import { InMemorySandboxProvider, sandboxContract } from '@agent/testing';

sandboxContract('in-memory', async () => ({ provider: new InMemorySandboxProvider(), close: async () => {} }));

test('exec and browser delegate to scripted handlers with a resolved cwd', async () => {
  const provider = new InMemorySandboxProvider({
    exec: (cmd, opts) => ({ stdout: `${opts.cwd}$ ${cmd}`, stderr: '', exitCode: 0, timedOut: false }),
    browser: action => ({
      url: action.type === 'open' ? action.url : 'about:blank',
      title: 'T',
      markdown: '# T',
      truncated: false,
      elements: [],
    }),
  });
  const s = await provider.create(crypto.randomUUID());
  expect((await s.exec('ls', { timeoutMs: 1000, cwd: 'outputs' })).stdout).toBe('/workspace/outputs$ ls');
  expect((await s.browser({ type: 'open', url: 'https://example.com' })).url).toBe('https://example.com');
});

test('without handlers exec returns 127 and browser fails clearly', async () => {
  const s = await new InMemorySandboxProvider().create(crypto.randomUUID());
  expect(await s.exec('ls', { timeoutMs: 1000 })).toMatchObject({ exitCode: 127, timedOut: false });
  let caught: unknown;
  try {
    await s.browser({ type: 'snapshot' });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(SandboxError);
  expect((caught as SandboxError).code).toBe('browser_failed');
});
