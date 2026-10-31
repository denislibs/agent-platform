// Проверяет, достигает ли песочница сервисов инфраструктуры хоста через шлюз сети Docker.
// Для самопроверки классификатора: PROBE_HOST и PROBE_PORTS (через запятую) переопределяют цель.
import { DockerSandboxProvider } from '../packages/sandbox/src';
import { loadConfig } from '../packages/shared/src';

const PORTS = [55432, 56379, 53900];

const sandbox = await new DockerSandboxProvider(loadConfig().sandbox).create(crypto.randomUUID());
try {
  const route = await sandbox.exec('cat /proc/net/route', { timeoutMs: 5_000 });
  const defaultRoute = route.stdout
    .split('\n')
    .map(line => line.trim().split(/\s+/))
    .find(cols => cols[1] === '00000000');
  const hex = defaultRoute?.[2];
  if (!hex) throw new Error(`no default route in:\n${route.stdout}`);
  const gateway = (hex.match(/../g) ?? [])
    .toReversed()
    .map(h => Number.parseInt(h, 16))
    .join('.');
  type Verdict = 'REACHABLE' | 'closed' | 'INCONCLUSIVE';
  // Открытый, но молчащий порт (Postgres/Valkey/S3 ждут клиента) нельзя отличить по curl: только по самому connect().
  const probe = async (host: string, port: number): Promise<Verdict> => {
    const r = await sandbox.exec(`timeout 3 bash -c 'exec 3<>/dev/tcp/${host}/${port}'`, { timeoutMs: 8_000 });
    if (r.exitCode === 0) return 'REACHABLE';
    if (r.exitCode === 124 || r.timedOut) return 'INCONCLUSIVE';
    return 'closed';
  };
  const target = process.env.PROBE_HOST ?? gateway;
  const ports = process.env.PROBE_PORTS ? process.env.PROBE_PORTS.split(',').map(Number) : PORTS;
  const verdicts: Verdict[] = [];
  for (const port of ports) {
    const verdict = await probe(target, port);
    verdicts.push(verdict);
    console.log(`${target}:${port} → ${verdict}`);
  }
  console.log(
    verdicts.includes('REACHABLE')
      ? 'RESULT: host services ARE reachable from the sandbox'
      : verdicts.includes('INCONCLUSIVE')
        ? 'RESULT: inconclusive (some ports timed out, none reachable)'
        : 'RESULT: host services are not reachable',
  );
} finally {
  await sandbox.destroy();
}
