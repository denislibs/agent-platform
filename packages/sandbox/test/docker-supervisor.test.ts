import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Sandbox } from '@agent/core';
import { loadConfig } from '@agent/shared';
import { DockerCli, DockerSandboxProvider } from '../src';
import { requireSandboxImage } from './helpers';

const cli = new DockerCli();
let sandbox: Sandbox;
const PAGE = '<!doctype html><html><head><title>Still Here</title></head><body><h1>alive</h1></body></html>';

beforeAll(async () => {
  await requireSandboxImage();
  sandbox = await new DockerSandboxProvider(loadConfig().sandbox).create(crypto.randomUUID());
  await sandbox.writeFile('site/page.html', PAGE);
});
afterAll(async () => {
  await sandbox?.destroy();
});

test('the sandbox survives browserd being killed, and the browser comes back', async () => {
  await sandbox.exec('setsid nohup sleep 300 >/dev/null 2>&1 &', { timeoutMs: 5_000 });
  // 'server[.]mjs' не совпадает с командной строкой самих timeout/bash, в которых записан шаблон.
  const killed = await sandbox.exec("pkill -f 'server[.]mjs'", { timeoutMs: 10_000 });
  expect(killed.exitCode).toBe(0);
  await Bun.sleep(300);
  // Контейнер жив: команды выполняются, фоновые процессы агента не погибли вместе с browserd.
  expect((await sandbox.exec('echo alive', { timeoutMs: 5_000 })).stdout).toBe('alive\n');
  expect((await sandbox.exec('pgrep -x sleep', { timeoutMs: 5_000 })).exitCode).toBe(0);
  const started = Date.now();
  const snap = await sandbox.browser({ type: 'open', url: 'file:///workspace/site/page.html' });
  expect(snap.title).toBe('Still Here');
  expect(Date.now() - started).toBeLessThan(20_000);
}, 40_000);

test('browserd is restarted again after repeated deaths', async () => {
  for (let i = 0; i < 2; i++) {
    expect((await sandbox.exec("pkill -9 -f 'server[.]mjs'", { timeoutMs: 10_000 })).exitCode).toBe(0);
    const snap = await sandbox.browser({ type: 'open', url: 'file:///workspace/site/page.html' });
    expect(snap.title).toBe('Still Here');
  }
}, 60_000);

test('docker stop still stops the sandbox promptly', async () => {
  const started = Date.now();
  await sandbox.stop();
  expect(Date.now() - started).toBeLessThan(4_000);
  const state = await cli.ok(['inspect', '--format', '{{.State.Status}} {{.State.ExitCode}}', sandbox.id]);
  expect(state.split(' ')[0]).toBe('exited');
  await sandbox.start();
  expect((await sandbox.browser({ type: 'open', url: 'file:///workspace/site/page.html' })).title).toBe('Still Here');
}, 40_000);

test('the init process is tini and browserd runs under the supervisor', async () => {
  const pid1 = (await sandbox.exec('cat /proc/1/cmdline | tr "\\0" " "', { timeoutMs: 5_000 })).stdout;
  expect(pid1).toMatch(/docker-init|tini/);
  const tree = (await sandbox.exec('ps -eo ppid,args', { timeoutMs: 5_000 })).stdout;
  expect(tree).toContain('supervise');
});
