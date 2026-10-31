// Проверяет, достигает ли песочница сервисов инфраструктуры хоста через шлюз сети Docker.
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
  let exposed = false;
  for (const port of PORTS) {
    const r = await sandbox.exec(`curl -s --max-time 3 telnet://${gateway}:${port} </dev/null`, { timeoutMs: 8_000 });
    const reachable = r.exitCode === 0;
    exposed ||= reachable;
    console.log(`${gateway}:${port} → curl exit ${r.exitCode} (${reachable ? 'REACHABLE' : 'blocked'})`);
  }
  console.log(
    exposed ? 'RESULT: host services ARE reachable from the sandbox' : 'RESULT: host services are not reachable',
  );
} finally {
  await sandbox.destroy();
}
