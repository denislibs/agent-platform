import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Sandbox } from '@agent/core';
import { loadConfig } from '@agent/shared';
import { DockerCli, DockerSandboxProvider } from '../src';
import { requireSandboxImage } from './helpers';

const cfg = loadConfig().sandbox;
const cli = new DockerCli();
let sandbox: Sandbox;
const sh = async (cmd: string) => sandbox.exec(cmd, { timeoutMs: 20_000 });

beforeAll(async () => {
  await requireSandboxImage();
  sandbox = await new DockerSandboxProvider(cfg).create(crypto.randomUUID());
});
afterAll(async () => {
  await sandbox?.destroy();
});

describe('process isolation', () => {
  test('runs as the unprivileged agent user', async () => {
    expect((await sh('id -u')).stdout.trim()).toBe('1001');
    expect((await sh('whoami')).stdout.trim()).toBe('agent');
  });

  test('has no capabilities and cannot gain privileges', async () => {
    expect((await sh("grep CapEff /proc/self/status | awk '{print $2}'")).stdout.trim()).toBe('0000000000000000');
    expect((await sh("grep CapBnd /proc/self/status | awk '{print $2}'")).stdout.trim()).toBe('0000000000000000');
    expect((await sh("grep NoNewPrivs /proc/self/status | awk '{print $2}'")).stdout.trim()).toBe('1');
  });

  test('cannot write outside /workspace and its home', async () => {
    for (const path of ['/etc/agent-test', '/opt/browserd/agent-test']) {
      const r = await sh(`touch ${path}`);
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toMatch(/Permission denied|Read-only/);
    }
  });

  test('has no secrets in its environment', async () => {
    const env = (await sh('env')).stdout;
    for (const name of ['DATABASE_URL', 'LITELLM', 'S3_', 'POSTGRES', 'VALKEY', 'BRAVE_API_KEY']) {
      expect(env).not.toContain(name);
    }
  });
});

describe('resource limits', () => {
  test('cpu, memory and pids limits come from the config', async () => {
    const out = await cli.ok([
      'inspect',
      '--format',
      '{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}} {{.HostConfig.PidsLimit}} {{json .HostConfig.CapDrop}} {{json .HostConfig.SecurityOpt}}',
      sandbox.id,
    ]);
    const [nanoCpus, memory, pids, capDrop, securityOpt] = out.split(' ');
    const units: Record<string, number> = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 };
    const unit = cfg.memory.slice(-1).toLowerCase();
    expect(Number(nanoCpus)).toBe(cfg.cpus * 1e9);
    expect(Number(memory)).toBe(Number.parseInt(cfg.memory, 10) * (units[unit] ?? 1));
    expect(Number(pids)).toBe(cfg.pids);
    expect(capDrop).toBe('["ALL"]');
    expect(securityOpt).toContain('no-new-privileges');
  });
});

describe('network isolation', () => {
  test('is attached only to the sandbox network', async () => {
    const networks = await cli.ok(['inspect', '--format', '{{json .NetworkSettings.Networks}}', sandbox.id]);
    expect(Object.keys(JSON.parse(networks))).toEqual([cfg.network]);
  });

  test('cannot resolve infrastructure services by name', async () => {
    // Позитивный контроль: резолвер работает, поэтому провал имён ниже — не артефакт сломанного DNS.
    expect((await sh('getent hosts localhost')).exitCode).toBe(0);
    for (const host of ['postgres', 'valkey', 'garage']) {
      expect((await sh(`getent hosts ${host}`)).exitCode).not.toBe(0);
    }
  });

  test('host.docker.internal points back at the sandbox itself', async () => {
    expect((await sh('getent hosts host.docker.internal')).stdout).toMatch(/^127\.0\.0\.1\s/);
    expect((await sh('curl -s --max-time 3 http://host.docker.internal:55432')).exitCode).not.toBe(0);
  });

  test('can reach the public internet', async () => {
    const r = await sh('curl -sI --max-time 15 -o /dev/null -w "%{http_code}" https://example.com');
    expect(r.stdout).toMatch(/^[23]\d\d$/);
  });
});
