import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SandboxError, type Sandbox } from '@agent/core';
import { loadConfig } from '@agent/shared';
import { DockerCli, DockerError, DockerSandboxProvider, type CliResult, type RunOptions } from '../src';
import { requireSandboxImage } from './helpers';

const cfg = loadConfig().sandbox;
const real = new DockerCli();
const created: Sandbox[] = [];
const networks: string[] = [];
const volumes: string[] = [];

/** Настоящий docker CLI, который записывает все вызовы. */
class RecordingCli extends DockerCli {
  readonly calls: string[][] = [];
  override async run(args: string[], opts?: RunOptions): Promise<CliResult> {
    this.calls.push(args);
    return super.run(args, opts);
  }
}

/**
 * Настоящий docker CLI, но `docker run` песочницы подключается к несуществующей сети: Docker создаёт
 * контейнер и падает на старте («network … not found»), оставляя его в состоянии Created.
 */
class BrokenStartCli extends DockerCli {
  runs = 0;
  override async run(args: string[], opts?: RunOptions): Promise<CliResult> {
    if (args[0] === 'run' && args.includes('-d')) {
      this.runs++;
      const i = args.indexOf('--network');
      return super.run(args.with(i + 1, `agent-sbx-missing-${crypto.randomUUID().slice(0, 8)}`), opts);
    }
    return super.run(args, opts);
  }
}

/** Том `agent-ws-<taskId>`, оставшийся от прежней жизни песочницы, с файлом old.txt = "kept". */
async function seedVolume(taskId: string): Promise<string> {
  const volume = `agent-ws-${taskId}`;
  volumes.push(volume);
  await real.ok(['volume', 'create', volume]);
  await real.ok([
    'run',
    '--rm',
    '--user',
    '0',
    '--mount',
    `type=volume,src=${volume},dst=/workspace`,
    '--entrypoint',
    'sh',
    cfg.image,
    '-c',
    'echo kept > /workspace/old.txt && chown -R 1001:1001 /workspace',
  ]);
  return volume;
}

const containersOf = (taskId: string) => real.ok(['ps', '-a', '-q', '--filter', `name=agent-sbx-${taskId}`]);
const volumesOf = (taskId: string) => real.ok(['volume', 'ls', '-q', '--filter', `name=agent-ws-${taskId}`]);

beforeAll(async () => {
  await requireSandboxImage();
});
afterAll(async () => {
  await Promise.all(created.map(s => s.destroy().catch(() => undefined)));
  await Promise.all(volumes.map(v => real.run(['volume', 'rm', '-f', v])));
  await Promise.all(networks.map(n => real.run(['network', 'rm', n])));
});

describe('destroy (M-1)', () => {
  test('a stale handle returns before touching any container or volume', async () => {
    const cli = new RecordingCli();
    const provider = new DockerSandboxProvider(cfg, cli);
    const taskId = crypto.randomUUID();
    const old = await provider.create(taskId);
    await old.destroy();
    const reborn = await provider.create(taskId);
    created.push(reborn);
    await reborn.writeFile('alive.txt', 'yes');
    cli.calls.length = 0;
    await old.destroy();
    expect(cli.calls.map(c => c[0])).toEqual(['inspect']);
    expect(cli.calls.some(c => c[0] === 'volume' || c[0] === 'rm')).toBe(false);
    expect(new TextDecoder().decode(await reborn.readFile('alive.txt'))).toBe('yes');
  }, 60_000);
});

describe('network (M-2)', () => {
  test('create recovers when the network is removed after the provider cached it', async () => {
    const network = `agent-sbx-nettest-${crypto.randomUUID().slice(0, 8)}`;
    networks.push(network);
    const provider = new DockerSandboxProvider({ ...cfg, network });
    const first = await provider.create(crypto.randomUUID());
    await first.destroy();
    await real.ok(['network', 'rm', network]);
    const taskId = crypto.randomUUID();
    const second = await provider.create(taskId);
    created.push(second);
    expect((await second.exec('echo ok', { timeoutMs: 5_000 })).stdout).toBe('ok\n');
    expect(await real.ok(['network', 'inspect', '--format', '{{json .Options}}', network])).toContain(
      '"com.docker.network.bridge.enable_icc":"false"',
    );
    // Неудачная первая попытка не оставила созданного контейнера.
    expect((await containersOf(taskId)).split('\n').filter(Boolean)).toHaveLength(1);
  }, 60_000);
});

describe('workspace volume (M-3)', () => {
  test('the workspace volume carries the sandbox and task labels', async () => {
    const taskId = crypto.randomUUID();
    const s = await new DockerSandboxProvider(cfg).create(taskId);
    created.push(s);
    const labels = JSON.parse(
      await real.ok(['volume', 'inspect', '--format', '{{json .Labels}}', `agent-ws-${taskId}`]),
    ) as Record<string, string>;
    expect(labels).toMatchObject({ 'agent.sandbox': '1', 'agent.task': taskId });
  });

  test('create reuses an existing workspace volume and its files', async () => {
    const taskId = crypto.randomUUID();
    await seedVolume(taskId);
    const s = await new DockerSandboxProvider(cfg).create(taskId);
    created.push(s);
    expect(new TextDecoder().decode(await s.readFile('old.txt'))).toBe('kept\n');
  });
});

describe('failed docker run (M-4)', () => {
  test('a fresh create whose container could not start removes the container and the volume it made', async () => {
    const taskId = crypto.randomUUID();
    const cli = new BrokenStartCli();
    let caught: unknown;
    try {
      created.push(await new DockerSandboxProvider(cfg, cli).create(taskId));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DockerError);
    expect((caught as DockerError).exitCode).not.toBe(0);
    expect((caught as DockerError).stderr).toMatch(/network .* not found/);
    // «network not found» повторяется ровно один раз (M-2), и обе попытки убраны за собой.
    expect(cli.runs).toBe(2);
    expect(await containersOf(taskId)).toBe('');
    expect(await volumesOf(taskId)).toBe('');
  }, 30_000);

  test('a failed docker run keeps a workspace volume that existed before the call (I-4)', async () => {
    const taskId = crypto.randomUUID();
    await seedVolume(taskId);
    let caught: unknown;
    try {
      created.push(await new DockerSandboxProvider(cfg, new BrokenStartCli()).create(taskId));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DockerError);
    expect(await containersOf(taskId)).toBe('');
    expect(await volumesOf(taskId)).toBe(`agent-ws-${taskId}`);
    const s = await new DockerSandboxProvider(cfg).create(taskId);
    created.push(s);
    expect(new TextDecoder().decode(await s.readFile('old.txt'))).toBe('kept\n');
  }, 30_000);
});

describe('pruned container and network (I-4)', () => {
  test('create after `docker system prune`-style cleanup keeps the surviving workspace', async () => {
    const network = `agent-sbx-nettest-${crypto.randomUUID().slice(0, 8)}`;
    networks.push(network);
    const provider = new DockerSandboxProvider({ ...cfg, network });
    const taskId = crypto.randomUUID();
    const first = await provider.create(taskId);
    await first.writeFile('keep.txt', 'survives');
    await first.stop();
    // Как prune: остановленный контейнер и неиспользуемая сеть удалены, том остался.
    await real.ok(['rm', `agent-sbx-${taskId}`]);
    await real.ok(['network', 'rm', network]);
    const again = await provider.create(taskId);
    created.push(again);
    expect(new TextDecoder().decode(await again.readFile('keep.txt'))).toBe('survives');
  }, 60_000);
});

describe('concurrent and foreign containers', () => {
  const provider = new DockerSandboxProvider(cfg);

  test('parallel create of the same task leaves one running sandbox', async () => {
    const taskId = crypto.randomUUID();
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => provider.create(taskId)));
    for (const r of results) if (r.status === 'fulfilled') created.push(r.value);
    expect(results.filter(r => r.status === 'rejected').map(r => String(r.reason))).toEqual([]);
    expect(results.every(r => r.status === 'fulfilled')).toBe(true);
    const info = (await provider.list()).find(i => i.taskId === taskId);
    expect(info?.running).toBe(true);
    const s = await provider.get(`agent-sbx-${taskId}`);
    expect((await s!.exec('echo ok', { timeoutMs: 10_000 })).stdout.trim()).toBe('ok');
    await s!.destroy();
  }, 60_000);

  test('create refuses a container with the sandbox name but without the label', async () => {
    const taskId = crypto.randomUUID();
    await real.ok(['create', '--name', `agent-sbx-${taskId}`, cfg.image]);
    try {
      const err = await provider.create(taskId).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(SandboxError);
      expect(err).toMatchObject({ code: 'foreign_container' });
      expect((err as Error).message).toMatch(/no agent\.sandbox label/);
    } finally {
      await real.run(['rm', '-f', `agent-sbx-${taskId}`]);
      await real.run(['volume', 'rm', '-f', `agent-ws-${taskId}`]);
    }
  });
});
