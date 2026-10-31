import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Sandbox } from '@agent/core';
import { loadConfig } from '@agent/shared';
import { DockerCli, DockerSandboxProvider, SandboxNetworkError } from '../src';
import { requireSandboxImage } from './helpers';
import { HTTP_PAYLOAD, probeReplies } from './reply-probe';

const cfg = loadConfig().sandbox;
const cli = new DockerCli();
const ICC = 'com.docker.network.bridge.enable_icc';
const created: Sandbox[] = [];
const networks: string[] = [];
const containers: string[] = [];

const iccOption = async (network: string) => {
  const options = JSON.parse(await cli.ok(['network', 'inspect', '--format', '{{json .Options}}', network])) as Record<
    string,
    string
  >;
  return options[ICC];
};
const scratchNetwork = () => {
  const name = `agent-sbx-nettest-${crypto.randomUUID().slice(0, 8)}`;
  networks.push(name);
  return name;
};

beforeAll(async () => {
  await requireSandboxImage();
});
afterAll(async () => {
  await Promise.all(created.map(s => s.destroy().catch(() => undefined)));
  await Promise.all(containers.map(c => cli.run(['rm', '-f', c])));
  await Promise.all(networks.map(n => cli.run(['network', 'rm', n])));
});

describe('inter-sandbox isolation', () => {
  test('the sandbox network has inter-container communication disabled', async () => {
    const s = await new DockerSandboxProvider(cfg).create(crypto.randomUUID());
    created.push(s);
    expect(await iccOption(cfg.network)).toBe('false');
  });

  test('a sandbox cannot reach a listener in another sandbox', async () => {
    const provider = new DockerSandboxProvider(cfg);
    const a = await provider.create(crypto.randomUUID());
    const b = await provider.create(crypto.randomUUID());
    created.push(a, b);
    const ipA = (await a.exec('hostname -i', { timeoutMs: 5_000 })).stdout.trim().split(/\s+/)[0] ?? '';
    expect(ipA).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    await a.exec('setsid nohup python3 -m http.server 8765 --bind 0.0.0.0 >/dev/null 2>&1 &', { timeoutMs: 5_000 });
    // Позитивный контроль: слушатель A отвечает на собственный IP — значит, тишина у B не из-за мёртвого сервера.
    let own = '';
    for (let i = 0; i < 40 && own !== '200'; i++) {
      own = (await a.exec(`curl -s -m 2 -o /dev/null -w '%{http_code}' http://${ipA}:8765/`, { timeoutMs: 5_000 }))
        .stdout;
      if (own !== '200') await Bun.sleep(250);
    }
    expect(own).toBe('200');
    const fromB = await b.exec(`curl -s -m 3 -o /dev/null -w '%{http_code}' http://${ipA}:8765/`, {
      timeoutMs: 10_000,
    });
    expect(fromB.stdout).not.toBe('200');
    expect(fromB.exitCode).not.toBe(0);
    const [probe] = await probeReplies(b, [{ host: ipA, port: 8765, payload: HTTP_PAYLOAD }]);
    expect(probe?.verdict).not.toBe('reply');
  }, 60_000);
});

describe('network provisioning', () => {
  test('a new network is created with ICC disabled', async () => {
    const network = scratchNetwork();
    const s = await new DockerSandboxProvider({ ...cfg, network }).create(crypto.randomUUID());
    created.push(s);
    expect(await iccOption(network)).toBe('false');
  });

  test('an unused network with ICC enabled is recreated with ICC disabled', async () => {
    const network = scratchNetwork();
    await cli.ok(['network', 'create', '--driver', 'bridge', network]);
    expect(await iccOption(network)).toBeUndefined();
    const s = await new DockerSandboxProvider({ ...cfg, network }).create(crypto.randomUUID());
    created.push(s);
    expect(await iccOption(network)).toBe('false');
    expect((await s.exec('echo ok', { timeoutMs: 5_000 })).stdout).toBe('ok\n');
  });

  test('a network with ICC enabled and containers attached (even stopped ones) is refused', async () => {
    const network = scratchNetwork();
    await cli.ok(['network', 'create', '--driver', 'bridge', network]);
    const holder = await cli.ok(['create', '--network', network, cfg.image, 'sleep', '60']);
    containers.push(holder);
    const taskId = crypto.randomUUID();
    let caught: unknown;
    try {
      created.push(await new DockerSandboxProvider({ ...cfg, network }).create(taskId));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SandboxNetworkError);
    expect((caught as SandboxNetworkError).code).toBe('icc_enabled');
    expect((caught as SandboxNetworkError).message).toContain(`docker network rm ${network}`);
    // Сеть не тронута, песочница не создана.
    expect(await iccOption(network)).toBeUndefined();
    expect(await cli.ok(['ps', '-a', '-q', '--filter', `name=agent-sbx-${taskId}`])).toBe('');
  });
});
