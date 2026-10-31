// Проверяет, получает ли песочница НАСТОЯЩИЙ ответ от сервисов инфраструктуры: через шлюз сети Docker,
// через все имена хоста (HOST_ALIASES), через IP хоста OrbStack и напрямую по IP контейнеров инфраструктуры.
// REACHABLE — только при реальном ответе сервиса (+PONG, ответ на SSLRequest, строка статуса HTTP);
// голый TCP connect показывается отдельно (CONNECT-ONLY): OrbStack может принимать соединение прокси.
// Для самопроверки классификатора: PROBE_HOST и PROBE_PORTS (через запятую) переопределяют цели.
import { DockerCli, DockerSandboxProvider, HOST_ALIASES } from '../packages/sandbox/src';
import {
  HTTP_PAYLOAD,
  INFRA_PORTS,
  ORBSTACK_HOST_IP,
  ProbeUnavailableError,
  probeReplies,
  type ProbeResult,
  type ProbeTarget,
} from '../packages/sandbox/test/reply-probe';
import { loadConfig } from '../packages/shared/src';

type Verdict = 'REACHABLE' | 'CONNECT-ONLY' | 'closed' | 'INCONCLUSIVE';
const VERDICT: Record<ProbeResult['verdict'], Verdict> = {
  reply: 'REACHABLE',
  connect_only: 'CONNECT-ONLY',
  refused: 'closed',
  unreachable: 'closed',
  unresolved: 'closed',
  timeout: 'INCONCLUSIVE',
  error: 'INCONCLUSIVE',
};
const INFRA_SERVICES: Record<string, { port: number; payload?: string }> = {
  postgres: { port: 5432, payload: '0000000804d2162f' },
  valkey: { port: 6379, payload: Buffer.from('PING\r\n').toString('hex') },
  garage: { port: 3900, payload: HTTP_PAYLOAD },
};

const cli = new DockerCli();
const sandbox = await new DockerSandboxProvider(loadConfig().sandbox).create(crypto.randomUUID());
try {
  const route = await sandbox.exec('cat /proc/net/route', { timeoutMs: 5_000 });
  const hex = route.stdout
    .split('\n')
    .map(line => line.trim().split(/\s+/))
    .find(cols => cols[1] === '00000000')?.[2];
  if (!hex) throw new Error(`no default route in:\n${route.stdout}`);
  const gateway = (hex.match(/../g) ?? [])
    .toReversed()
    .map(h => Number.parseInt(h, 16))
    .join('.');

  const targets: (ProbeTarget & { label: string })[] = [];
  const ports = process.env.PROBE_PORTS
    ? process.env.PROBE_PORTS.split(',').map(Number)
    : Object.values<number>(INFRA_PORTS);
  const hosts = process.env.PROBE_HOST ? [process.env.PROBE_HOST] : [gateway, ...HOST_ALIASES, ORBSTACK_HOST_IP];
  for (const host of hosts) for (const port of ports) targets.push({ host, port, label: `${host}:${port}` });
  if (!process.env.PROBE_HOST) {
    const services = await cli.ok([
      'ps',
      '--filter',
      'label=com.docker.compose.project=agent-dev',
      '--format',
      '{{.Names}}\t{{.Label "com.docker.compose.service"}}',
    ]);
    for (const line of services.split('\n').filter(Boolean)) {
      const [name = '', service = ''] = line.split('\t');
      const svc = INFRA_SERVICES[service];
      if (!svc) continue;
      const ips = await cli.ok([
        'inspect',
        '--format',
        '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}',
        name,
      ]);
      for (const ip of ips.split(' ').filter(Boolean)) {
        targets.push({
          host: ip,
          port: svc.port,
          payload: svc.payload,
          label: `${service} container ${ip}:${svc.port}`,
        });
      }
    }
  }

  let verdicts: { label: string; verdict: Verdict; detail: string }[];
  try {
    const results = await probeReplies(sandbox, targets);
    verdicts = results.map((r, i) => ({
      label: targets[i]?.label ?? `${r.host}:${r.port}`,
      verdict: VERDICT[r.verdict],
      detail: `${r.verdict}: ${JSON.stringify(r.detail.slice(0, 40))}`,
    }));
  } catch (err) {
    // exit 127 (нет python3) и прочие сбои самой пробы — это «не знаем», а не «закрыто».
    if (!(err instanceof ProbeUnavailableError)) throw err;
    verdicts = targets.map(t => ({ label: t.label, verdict: 'INCONCLUSIVE', detail: err.message }));
  }
  for (const v of verdicts) console.log(`${v.label.padEnd(44)} → ${v.verdict.padEnd(12)} (${v.detail})`);

  const of = (verdict: Verdict) => verdicts.filter(v => v.verdict === verdict).map(v => v.label);
  const reachable = of('REACHABLE');
  const connectOnly = of('CONNECT-ONLY');
  const inconclusive = of('INCONCLUSIVE');
  console.log(`\nREACHABLE (real service reply): ${reachable.length ? reachable.join(', ') : 'none'}`);
  console.log(`CONNECT-ONLY (TCP accepted, no reply): ${connectOnly.length ? connectOnly.join(', ') : 'none'}`);
  console.log(`INCONCLUSIVE: ${inconclusive.length ? inconclusive.join(', ') : 'none'}`);
  console.log(
    reachable.length
      ? 'RESULT: host services ARE reachable from the sandbox'
      : inconclusive.length
        ? 'RESULT: inconclusive (no real reply, but some probes could not decide)'
        : connectOnly.length
          ? 'RESULT: no real reply from host services (some TCP connects were accepted without a reply)'
          : 'RESULT: host services are not reachable',
  );
  if (reachable.length) process.exitCode = 1;
} finally {
  await sandbox.destroy();
}
