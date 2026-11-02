import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Sandbox } from '@agent/core';
import { loadConfig } from '@agent/shared';
import { DockerCli, DockerError, DockerSandboxProvider, type CliResult, type RunOptions } from '../src';
import { requireSandboxImage } from './helpers';
import {
  APP_PAYLOAD,
  APP_PORT,
  EXPECTED_HOST_ALIASES,
  HTTP_PAYLOAD,
  INFRA_PORTS,
  ORBSTACK_HOST_IP,
  PAYLOAD_BY_PORT,
  probeReplies,
  type ProbeTarget,
} from './reply-probe';

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

describe('restart policy', () => {
  test('the container has no automatic restart policy', async () => {
    // Правила egress ставит провайдер при каждом запуске; перезапуск силами демона прошёл бы мимо них.
    // Падение самой песочницы даёт not_running, и provider.create(taskId) поднимает её с правилами.
    const policy = await cli.ok(['inspect', '--format', '{{.HostConfig.RestartPolicy.Name}}', sandbox.id]);
    expect(['', 'no']).toContain(policy);
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

  test('every host alias points back at the sandbox itself', async () => {
    for (const alias of EXPECTED_HOST_ALIASES) {
      const r = await sh(`getent ahosts ${alias}`);
      expect({ alias, out: r.stdout.trim().split('\n')[0] ?? '' }).toEqual({
        alias,
        out: expect.stringMatching(/^127\.0\.0\.1\s/),
      });
      // Ни одного адреса, кроме 127.0.0.1: закреплённое имя не должно резолвиться ещё куда-то.
      expect(r.stdout.split('\n').filter(l => l.trim() && !l.startsWith('127.0.0.1'))).toEqual([]);
    }
  });

  test('the probe payloads get real replies from the infrastructure when it is reachable (host-side control)', async () => {
    // Позитивный контроль: те же байты с хоста получают настоящий ответ — значит, «нет ответа» из песочницы
    // означает недоступность, а не неудачный payload.
    for (const port of Object.values(INFRA_PORTS)) {
      const reply = await hostReply('127.0.0.1', port, PAYLOAD_BY_PORT[port] ?? HTTP_PAYLOAD);
      expect({ port, replied: reply.length > 0 }).toEqual({ port, replied: true });
    }
  });

  test('infrastructure gives no real reply via host aliases, host IPs, the gateway or the infra containers', async () => {
    const targets: ProbeTarget[] = [];
    const gateway = await cli.ok([
      'network',
      'inspect',
      '--format',
      '{{range .IPAM.Config}}{{.Gateway}}{{end}}',
      cfg.network,
    ]);
    expect(gateway).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    // Порт приложения проверяется, когда стек поднят (bun run stack:up): с одним infra:up он закрыт и на хосте.
    // Host: localhost (APP_PAYLOAD) — на чужой Host nginx не отвечает (444), и проба порта ничего бы не проверяла.
    const appUp = (await hostReply('127.0.0.1', APP_PORT, APP_PAYLOAD)).length > 0;
    // REQUIRE_APP_STACK=1 — стек обязан быть поднят: без этого «стек лежит» неотличим от «порт проверен».
    const requireApp = process.env.REQUIRE_APP_STACK === '1';
    if (requireApp) expect({ appUp }).toEqual({ appUp: true });
    for (const host of [...EXPECTED_HOST_ALIASES, ORBSTACK_HOST_IP, gateway]) {
      for (const port of Object.values(INFRA_PORTS)) targets.push({ host, port });
      if (appUp) targets.push({ host, port: APP_PORT, payload: APP_PAYLOAD });
    }
    // Сами контейнеры инфраструктуры по их IP в соседней сети Docker (на OrbStack сети друг друга видят).
    const infra = await infraContainers();
    expect(infra.length).toBeGreaterThanOrEqual(3);
    if (requireApp) expect(infra.map(c => c.port)).toEqual(expect.arrayContaining([3000, 8080, 2375]));
    for (const c of infra) targets.push({ host: c.ip, port: c.port, payload: c.payload });
    targets.push({ host: '169.254.169.254', port: 80, payload: HTTP_PAYLOAD });
    // Позитивный контроль внутри той же пробы: browserd внутри песочницы отвечает по HTTP.
    const control = { host: '127.0.0.1', port: 9230, payload: HTTP_PAYLOAD };
    const results = await probeReplies(sandbox, [control, ...targets]);
    expect(results[0]).toMatchObject({ verdict: 'reply', detail: expect.stringMatching(/^HTTP\/1\.[01] /) });
    const replies = results.slice(1).filter(r => r.verdict === 'reply');
    expect(replies).toEqual([]);
    expect(results.slice(1)).toHaveLength(targets.length);
  }, 60_000);

  test('the agent cannot remove the egress block rules', async () => {
    const rules = (await sh('ip rule show')).stdout;
    const subnet = (await sh("ip -4 route show scope link proto kernel | awk '{print $1; exit}'")).stdout.trim();
    for (const dest of ['0.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', subnet]) {
      expect(rules).toContain(`to ${dest} blackhole`);
    }
    const del = await sh('ip rule del pref 100');
    expect(del.exitCode).not.toBe(0);
    expect(del.stderr).toMatch(/Operation not permitted/);
    expect((await sh('ip rule show')).stdout).toContain('to 0.0.0.0/8 blackhole');
  });

  test('the egress block is re-applied when the sandbox starts again', async () => {
    await sandbox.stop();
    await sandbox.start();
    expect((await sh('ip rule show')).stdout).toContain('to 0.0.0.0/8 blackhole');
    const [valkey] = await probeReplies(sandbox, [{ host: ORBSTACK_HOST_IP, port: INFRA_PORTS.valkey }]);
    expect(valkey?.verdict).not.toBe('reply');
  }, 60_000);

  test('can reach the public internet', async () => {
    const r = await sh('curl -sI --max-time 15 -o /dev/null -w "%{http_code}" https://example.com');
    expect(r.stdout).toMatch(/^[23]\d\d$/);
  });

  test('the sandbox has no global IPv6 address or route', async () => {
    // Допустимы только link-local (scope 20) и ::1 на lo (scope 10): ни того, ни другого наружу не пустит.
    const addr = await sh(
      'cat /proc/net/if_inet6 2>/dev/null | awk \'!($4 == "20" || ($1 == "00000000000000000000000000000001" && $6 == "lo")) {print}\'',
    );
    expect(addr.stdout.trim()).toBe('');
    const route = await sh('ip -6 route show default 2>/dev/null');
    expect(route.stdout.trim()).toBe('');
  });
});

/** Отправляет payload с хоста и возвращает первые байты ответа (пусто — ответа не было). */
async function hostReply(host: string, port: number, payloadHex: string): Promise<string> {
  const { connect } = await import('node:net');
  return new Promise(resolve => {
    const socket = connect({ host, port });
    let data = '';
    const done = () => {
      socket.destroy();
      resolve(data);
    };
    socket.setTimeout(3_000, done);
    socket.on('connect', () => socket.write(Buffer.from(payloadHex, 'hex')));
    socket.on('data', chunk => {
      data += chunk.toString('latin1');
      done();
    });
    socket.on('error', done);
    socket.on('close', done);
  });
}

const blackholes = async () =>
  (await sh('ip rule show pref 100')).stdout
    .split('\n')
    .filter(l => l.includes('blackhole'))
    .toSorted();

describe('egress block re-apply (C-1a)', () => {
  const RACE_LOOP_PY = String.raw`
import os, socket, sys, time
targets = [(h, int(p)) for h, p in (t.split(':') for t in sys.argv[1:])]
attempts = 0
with open('/tmp/race-hits.log', 'a') as hits:
    while not os.path.exists('/tmp/race-stop'):
        for host, port in targets:
            attempts += 1
            try:
                s = socket.create_connection((host, port), timeout=0.2)
                s.settimeout(0.5)
                s.sendall(b'PING\r\n')
                data = s.recv(16)
                s.close()
                if data:
                    hits.write(f'{host}:{port} {data!r}\n')
                    hits.flush()
            except OSError:
                pass
        if attempts % 200 == 0:
            with open('/tmp/race-attempts', 'w') as f:
                f.write(str(attempts))
    with open('/tmp/race-attempts', 'w') as f:
        f.write(str(attempts))
`;

  test('create() on a running sandbox never leaves a gap in the block', async () => {
    const valkey = (await infraContainers()).find(c => c.port === 6379);
    expect(valkey).toBeDefined();
    const targets = [`${ORBSTACK_HOST_IP}:${INFRA_PORTS.valkey}`, `${valkey?.ip}:6379`];
    await sh('rm -f /tmp/race-hits.log /tmp/race-stop /tmp/race-attempts /tmp/race-loop.py');
    await sandbox.writeFile('/workspace/.race-loop.py', RACE_LOOP_PY);
    await sh(`setsid nohup python3 /workspace/.race-loop.py ${targets.join(' ')} >/dev/null 2>&1 &`);
    const provider = new DockerSandboxProvider(cfg);
    for (let i = 0; i < 20; i++) {
      const again = await provider.create(sandbox.taskId);
      expect(again.id).toBe(sandbox.id);
    }
    await sh('touch /tmp/race-stop');
    await Bun.sleep(1_000);
    const attempts = Number((await sh('cat /tmp/race-attempts')).stdout.trim());
    const hits = (await sh('cat /tmp/race-hits.log 2>/dev/null || true')).stdout;
    await sh('rm -f /tmp/race-hits.log /tmp/race-stop /tmp/race-attempts /workspace/.race-loop.py');
    // Позитивный контроль: петля действительно долбилась всё время повторных create().
    expect(attempts).toBeGreaterThan(200);
    expect(hits).toBe('');
  }, 120_000);

  test('re-apply keeps exactly one rule per destination and drops stale ones', async () => {
    const before = await blackholes();
    // Устаревшее правило, которого нет в нынешнем наборе (как после смены BLOCKED_EGRESS).
    await cli.ok([
      'run',
      '--rm',
      '--network',
      `container:${sandbox.id}`,
      '--user',
      '0',
      '--cap-drop',
      'ALL',
      '--cap-add',
      'NET_ADMIN',
      '--entrypoint',
      'ip',
      cfg.image,
      'rule',
      'add',
      'pref',
      '100',
      'to',
      '203.0.113.0/24',
      'blackhole',
    ]);
    expect((await blackholes()).some(l => l.includes('203.0.113.0/24'))).toBe(true);
    await new DockerSandboxProvider(cfg).create(sandbox.taskId);
    await new DockerSandboxProvider(cfg).create(sandbox.taskId);
    expect(await blackholes()).toEqual(before);
  }, 60_000);

  test('a rule error other than "File exists" still fails the helper and stops the sandbox', async () => {
    /** Настоящий docker CLI, но помощнику egress добавлено назначение, которое `ip rule add` отвергнет. */
    class BadRuleCli extends DockerCli {
      override async run(args: string[], opts?: RunOptions): Promise<CliResult> {
        if (args[0] === 'run' && args.includes('NET_ADMIN')) return super.run([...args, '300.0.0.0/8'], opts);
        return super.run(args, opts);
      }
    }
    const own = await new DockerSandboxProvider(cfg).create(crypto.randomUUID());
    try {
      let caught: unknown;
      try {
        await new DockerSandboxProvider(cfg, new BadRuleCli()).create(own.taskId);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DockerError);
      expect((caught as DockerError).stderr).toMatch(/valid prefix/);
      expect(await cli.ok(['inspect', '--format', '{{.State.Running}}', own.id])).toBe('false');
    } finally {
      await own.destroy();
    }
  }, 60_000);
});

const INFRA_SERVICES: Record<string, { port: number; payload: string }> = {
  postgres: { port: 5432, payload: PAYLOAD_BY_PORT[INFRA_PORTS.postgres] ?? '' },
  valkey: { port: 6379, payload: PAYLOAD_BY_PORT[INFRA_PORTS.valkey] ?? '' },
  garage: { port: 3900, payload: HTTP_PAYLOAD },
  api: { port: 3000, payload: HTTP_PAYLOAD },
  nginx: { port: 8080, payload: APP_PAYLOAD },
  'docker-proxy': { port: 2375, payload: HTTP_PAYLOAD },
};

/** IP и внутренние порты контейнеров инфраструктуры (compose-проект agent-dev). */
async function infraContainers(): Promise<{ ip: string; port: number; payload: string }[]> {
  const out = await cli.ok([
    'ps',
    '--filter',
    'label=com.docker.compose.project=agent-dev',
    '--format',
    '{{.Label "com.docker.compose.service"}}',
  ]);
  const result: { ip: string; port: number; payload: string }[] = [];
  for (const service of out.split('\n').filter(Boolean)) {
    const svc = INFRA_SERVICES[service];
    if (!svc) continue;
    const ips = await cli.ok([
      'inspect',
      '--format',
      '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}',
      `agent-dev-${service}-1`,
    ]);
    for (const ip of ips.split(' ').filter(Boolean)) result.push({ ip, ...svc });
  }
  return result;
}
