import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Sandbox } from '@agent/core';
import { DockerCli, DockerSandboxProvider } from '@agent/sandbox';
import { FakeSearchProvider, testConfig } from '@agent/testing';
import { loadConfig } from '@agent/shared';
import { executorTools, runToolCall, type ToolContext } from '../../src';

// Тот же образ и та же проверка, что в packages/sandbox/test/helpers.ts (requireSandboxImage).
const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE ?? 'agent-sandbox:dev';
async function requireSandboxImage(): Promise<void> {
  const r = await new DockerCli().run(['image', 'inspect', SANDBOX_IMAGE]);
  if (r.exitCode !== 0)
    throw new Error(`Sandbox image ${SANDBOX_IMAGE} is missing — run \`bun run sandbox:build\` first.`);
}

let sandbox: Sandbox;
let n = 0;
const ctx = (): ToolContext => ({
  taskId: sandbox.taskId,
  subtaskId: null,
  callKey: `smoke-${++n}`,
  sandbox,
  search: new FakeSearchProvider(),
  limits: testConfig().limits,
});
const run = (name: string, args: unknown) =>
  runToolCall(executorTools, { id: `c${n}`, name, rawArgs: JSON.stringify(args), args }, ctx());

beforeAll(async () => {
  await requireSandboxImage();
  sandbox = await new DockerSandboxProvider(loadConfig().sandbox).create(crypto.randomUUID());
}, 60_000);
afterAll(async () => {
  await sandbox?.destroy();
}, 60_000);

test('file and shell tools work end to end on a Docker sandbox', async () => {
  expect(await run('file_write', { path: 'notes/a.md', content: 'hello\nworld\n' })).toEqual({
    ok: true,
    output: 'wrote 12 bytes to notes/a.md',
  });
  expect(await run('file_read', { path: 'notes/a.md' })).toEqual({ ok: true, output: 'hello\nworld\n' });
  expect(await run('file_edit', { path: 'notes/a.md', old: 'world', new: 'docker' })).toEqual({
    ok: true,
    output: 'edited notes/a.md',
  });
  expect(await run('file_list', {})).toEqual({ ok: true, output: 'notes/\nnotes/a.md (13 B)' });
  const ls = await run('shell', { cmd: 'ls notes && cat notes/a.md' });
  expect(ls).toEqual({ ok: true, output: 'exit code: 0\nstdout:\na.md\nhello\ndocker\n' });
}, 60_000);

test('file_write onto a folder is an fs_error result for the model, not an exception', async () => {
  await run('file_write', { path: 'outputs/report.md', content: 'x' });
  const r = await run('file_write', { path: 'outputs', content: 'oops' });
  expect(r).toMatchObject({ ok: false, error: 'tool' });
  expect(r.output).toContain('writeFile outputs failed');
  expect(r.output).toContain('Is a directory');
  expect(r.output).not.toContain('/workspace');
}, 60_000);
