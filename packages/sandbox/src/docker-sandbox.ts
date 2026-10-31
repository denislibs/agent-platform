import {
  NotFoundError,
  resolveWorkspacePath,
  SandboxError,
  toWorkspaceRelative,
  WORKSPACE_ROOT,
  type BrowserAction,
  type ExecOptions,
  type ExecResult,
  type FileEntry,
  type PageSnapshot,
  type Sandbox,
  type SandboxInfo,
  type SandboxProvider,
} from '@agent/core';
import { DockerCli, DockerError, type CliResult } from './docker-cli';
import { BrowserdResponseSchema } from './page-snapshot';

export interface DockerSandboxConfig {
  image: string;
  network: string;
  cpus: number;
  memory: string;
  pids: number;
}

const NAME_PREFIX = 'agent-sbx-';
const LABEL = 'agent.sandbox';
const TASK_LABEL = 'agent.task';
const BROWSERD_HEALTH = 'http://127.0.0.1:9230/health';
const BROWSERD_ACTION = 'http://127.0.0.1:9230/action';
const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/;
const DAEMON_ERROR = /^Error response from daemon/i;
const NOT_RUNNING = /is not running|is paused|is restarting/i;
const NO_SUCH_CONTAINER = /no such (object|container)/i;

/**
 * Имена, под которыми Docker Desktop и OrbStack отдают контейнерам хост. Все закрепляются за 127.0.0.1
 * самой песочницы (`--add-host`), чтобы по имени нельзя было дойти до сервисов хоста.
 */
export const HOST_ALIASES = [
  'host.docker.internal',
  'host.orb.internal',
  'host.internal',
  'gateway.docker.internal',
  'docker.for.mac.localhost',
  'docker.for.mac.host.internal',
] as const;

/**
 * Назначения, закрытые в сетевом пространстве песочницы правилами `ip rule … blackhole`. Сверх списка
 * закрываются шлюз сети (/32) и вся собственная подсеть песочницы — там живут другие песочницы.
 * Закрепление имён не мешает ходить на хост по IP: на OrbStack хост — 0.250.250.254, контейнеры
 * инфраструктуры видны по своим адресам из соседних сетей, а `enable_icc=false` OrbStack не соблюдает.
 * Свой IP и 127.0.0.0/8 остаются доступны: таблица local проверяется раньше этих правил.
 */
export const BLOCKED_EGRESS = [
  '0.0.0.0/8', // OrbStack: 0.250.250.254 — это хост
  '10.0.0.0/8',
  '100.64.0.0/10', // CGNAT, Tailscale
  '169.254.0.0/16', // link-local, облачные метаданные 169.254.169.254
  '172.16.0.0/12',
  '192.168.0.0/16',
  '198.18.0.0/15', // сеть VM OrbStack
] as const;

const ICC_OPTION = 'com.docker.network.bridge.enable_icc';

/** Сеть песочниц существует с включённым ICC, и пересоздать её нельзя: к ней подключены контейнеры. */
export class SandboxNetworkError extends Error {
  readonly code = 'icc_enabled' as const;
  constructor(
    readonly network: string,
    readonly attached: number,
  ) {
    super(
      `sandbox network "${network}" allows traffic between containers (ICC is on) and still has ${attached} ` +
        `container(s) attached. Remove them and run \`docker network rm ${network}\`; ` +
        'the next sandbox create recreates it with ICC disabled.',
    );
    this.name = 'SandboxNetworkError';
  }
}

const containerName = (taskId: string) => `${NAME_PREFIX}${taskId}`;
const volumeName = (taskId: string) => `agent-ws-${taskId}`;
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const byPath = (a: FileEntry, b: FileEntry) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/**
 * Песочница — это один Docker-контейнер. Публичный `id` — стабильное имя `agent-sbx-<taskId>`,
 * но все операции адресуются по ID контейнера, захваченному при создании: «протухший» хэндл
 * не может задеть контейнер, пересозданный под тем же именем.
 */
export class DockerSandbox implements Sandbox {
  constructor(
    readonly id: string,
    readonly taskId: string,
    private readonly containerId: string,
    private readonly cli: DockerCli,
    private readonly settings: SandboxSettings,
  ) {}

  /** docker exec внутри песочницы; ошибки самого Docker превращаются в ошибки порта. */
  private async execRaw(
    argv: string[],
    opts: { stdin?: string | Uint8Array; timeoutMs?: number; cwd?: string } = {},
  ): Promise<CliResult> {
    const args = ['exec', '-i'];
    if (opts.cwd) args.push('-w', opts.cwd);
    args.push(this.containerId, ...argv);
    const r = await this.cli.run(args, {
      stdin: opts.stdin ?? '',
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    });
    if (r.exitCode !== 0 && DAEMON_ERROR.test(r.stderr)) {
      if (NO_SUCH_CONTAINER.test(r.stderr)) throw new NotFoundError('sandbox', this.id);
      if (NOT_RUNNING.test(r.stderr)) {
        throw new SandboxError('not_running', `sandbox ${this.id} is stopped`);
      }
      throw new DockerError(args, r.exitCode, r.stderr);
    }
    return r;
  }

  async exec(cmd: string, opts: ExecOptions): Promise<ExecResult> {
    const cwd = resolveWorkspacePath(opts.cwd ?? WORKSPACE_ROOT);
    const seconds = Math.max(1, Math.ceil(opts.timeoutMs / 1000));
    const started = Date.now();
    const r = await this.execRaw(['timeout', '--kill-after=2', String(seconds), 'bash', '-c', cmd], {
      cwd,
      stdin: opts.stdin ?? '',
      timeoutMs: opts.timeoutMs + 15_000,
    });
    const elapsed = Date.now() - started;
    const timedOut = r.exitCode === 124 || (r.exitCode === 137 && elapsed >= opts.timeoutMs);
    return { stdout: decode(r.stdout), stderr: r.stderr, exitCode: r.exitCode, timedOut };
  }

  async readFile(path: string): Promise<Uint8Array> {
    const abs = resolveWorkspacePath(path);
    const r = await this.execRaw(['cat', '--', abs]);
    if (r.exitCode !== 0) {
      if (/No such file or directory/i.test(r.stderr)) throw new NotFoundError('file', toWorkspaceRelative(abs));
      throw new Error(`readFile ${toWorkspaceRelative(abs)} failed: ${r.stderr.trim()}`);
    }
    return r.stdout;
  }

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    const abs = resolveWorkspacePath(path);
    const r = await this.execRaw(['sh', '-c', 'mkdir -p "$(dirname "$1")" && cat > "$1"', 'sh', abs], {
      stdin: data,
    });
    if (r.exitCode !== 0) throw new Error(`writeFile ${toWorkspaceRelative(abs)} failed: ${r.stderr.trim()}`);
  }

  async list(path: string, depth: number): Promise<FileEntry[]> {
    const abs = resolveWorkspacePath(path);
    const r = await this.execRaw([
      'find',
      abs,
      '-mindepth',
      '1',
      '-maxdepth',
      String(Math.max(1, depth)),
      '(',
      '-type',
      'f',
      '-o',
      '-type',
      'd',
      ')',
      '-printf',
      '%y\\t%s\\t%p\\0',
    ]);
    if (r.exitCode !== 0) {
      if (/No such file or directory/i.test(r.stderr)) throw new NotFoundError('file', toWorkspaceRelative(abs));
      throw new Error(`list ${toWorkspaceRelative(abs)} failed: ${r.stderr.trim()}`);
    }
    return decode(r.stdout)
      .split('\0')
      .filter(Boolean)
      .map(line => {
        // Путь — всё после второго TAB: в самом имени файла могут быть и TAB, и перевод строки.
        const sizeEnd = line.indexOf('\t', line.indexOf('\t') + 1);
        const isDir = line.startsWith('d');
        return {
          path: toWorkspaceRelative(line.slice(sizeEnd + 1)),
          type: isDir ? ('dir' as const) : ('file' as const),
          size: isDir ? 0 : Number(line.slice(2, sizeEnd)),
        };
      })
      .toSorted(byPath);
  }

  async browser(action: BrowserAction): Promise<PageSnapshot> {
    const r = await this.execRaw(
      [
        'curl',
        '-s',
        '--max-time',
        '60',
        '-X',
        'POST',
        '-H',
        'content-type: application/json',
        '--data-binary',
        '@-',
        BROWSERD_ACTION,
      ],
      { stdin: JSON.stringify(action), timeoutMs: 75_000 },
    );
    if (r.exitCode !== 0) {
      throw new SandboxError('browser_failed', `browserd is unreachable (curl exit ${r.exitCode}): ${r.stderr.trim()}`);
    }
    let json: unknown;
    try {
      json = JSON.parse(decode(r.stdout));
    } catch {
      throw new SandboxError('browser_failed', 'browserd returned a response that is not valid JSON');
    }
    const parsed = BrowserdResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new SandboxError('browser_failed', `unexpected browserd response: ${parsed.error.message}`);
    }
    const body = parsed.data;
    if (!body.ok) {
      throw new SandboxError(body.code === 'element_not_found' ? 'element_not_found' : 'browser_failed', body.error);
    }
    return body.snapshot;
  }

  async stop(): Promise<void> {
    await this.lifecycle(['stop', '-t', '5', this.containerId]);
  }

  async start(): Promise<void> {
    await this.lifecycle(['start', this.containerId]);
    await blockEgressOrStop(this.cli, this.settings.image, this.containerId, this.id);
    await waitForBrowserd(this.cli, this.containerId, this.id);
  }

  async destroy(): Promise<void> {
    const r = await this.cli.run(['rm', '-f', this.containerId]);
    if (r.exitCode !== 0) {
      // Контейнера уже нет (в том числе: имя занято новым контейнером) — том не наш, не трогаем.
      if (NO_SUCH_CONTAINER.test(r.stderr)) return;
      throw new DockerError(['rm', this.containerId], r.exitCode, r.stderr);
    }
    await this.cli.run(['volume', 'rm', '-f', volumeName(this.taskId)]);
  }

  private async lifecycle(args: string[]): Promise<void> {
    const r = await this.cli.run(args);
    if (r.exitCode !== 0) {
      if (NO_SUCH_CONTAINER.test(r.stderr)) throw new NotFoundError('sandbox', this.id);
      throw new DockerError(args, r.exitCode, r.stderr);
    }
  }
}

const DEFAULT_HEALTH_ATTEMPTS = 40;

/** Что DockerSandbox берёт у провайдера. */
interface SandboxSettings {
  image: string;
}

/** Приоритет правил блокировки: после таблицы local (0), до main (32766). */
const EGRESS_RULE_PREF = '100';

/**
 * Ставит правила BLOCKED_EGRESS (плюс шлюз и подсеть) в сетевое пространство запущенной песочницы.
 * Делает это короткоживущий служебный контейнер с одной лишь NET_ADMIN, разделяющий сеть песочницы:
 * у самой песочницы capabilities нет, снять правила она не может. Правила живут, пока жив netns, —
 * поэтому их ставит каждый запуск через провайдер, а политики автоперезапуска у контейнера нет.
 */
async function blockEgress(cli: DockerCli, image: string, containerId: string, id: string): Promise<void> {
  const script = [
    'set -e',
    "gw=$(ip -4 route show default | awk '{print $3; exit}')",
    "subnet=$(ip -4 route show scope link proto kernel | awk '{print $1; exit}')",
    '[ -n "$gw" ] && [ -n "$subnet" ] || { echo "no default route or subnet" >&2; exit 1; }',
    `while ip rule del pref ${EGRESS_RULE_PREF} 2>/dev/null; do :; done`,
    `for d in "$@" "$subnet" "$gw/32"; do ip rule add pref ${EGRESS_RULE_PREF} to "$d" blackhole; done`,
  ].join('\n');
  const args = [
    'run',
    '--rm',
    '--network',
    `container:${containerId}`,
    '--user',
    '0',
    '--cap-drop',
    'ALL',
    '--cap-add',
    'NET_ADMIN',
    '--security-opt',
    'no-new-privileges',
    '--entrypoint',
    'sh',
    image,
    '-c',
    script,
    'sh',
    ...BLOCKED_EGRESS,
  ];
  const r = await cli.run(args, { timeoutMs: 30_000 });
  if (r.exitCode === 0) return;
  if (NO_SUCH_CONTAINER.test(r.stderr)) throw new NotFoundError('sandbox', id);
  if (/non running container|is not running/i.test(r.stderr)) {
    throw new SandboxError('not_running', `sandbox ${id} is stopped`);
  }
  throw new DockerError(['run', 'egress-block', containerId], r.exitCode, r.stderr);
}

/** Не удалось закрыть исходящий трафик — песочница не должна работать без него: останавливаем. */
async function blockEgressOrStop(cli: DockerCli, image: string, containerId: string, id: string): Promise<void> {
  try {
    await blockEgress(cli, image, containerId, id);
  } catch (err) {
    await cli.run(['stop', '-t', '1', containerId]).catch(() => undefined);
    throw err;
  }
}

async function waitForBrowserd(
  cli: DockerCli,
  containerId: string,
  id: string,
  attempts = DEFAULT_HEALTH_ATTEMPTS,
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    const r = await cli.run(['exec', containerId, 'curl', '-sf', '-m', '2', BROWSERD_HEALTH], { timeoutMs: 5_000 });
    if (r.exitCode === 0) return;
    if (DAEMON_ERROR.test(r.stderr)) {
      if (NO_SUCH_CONTAINER.test(r.stderr)) throw new NotFoundError('sandbox', id);
      if (NOT_RUNNING.test(r.stderr)) throw new SandboxError('not_running', `sandbox ${id} is stopped`);
    }
    await Bun.sleep(250);
  }
  throw new DockerError(['exec', containerId], 1, `browserd did not become healthy after ${attempts} attempts`);
}

interface ContainerInfo {
  containerId: string;
  labeled: boolean;
  running: boolean;
}

export class DockerSandboxProvider implements SandboxProvider {
  private networkReady: Promise<void> | undefined;

  constructor(
    private readonly cfg: DockerSandboxConfig,
    private readonly cli: DockerCli = new DockerCli(),
    private readonly opts: { healthAttempts?: number } = {},
  ) {}

  private get settings(): SandboxSettings {
    return { image: this.cfg.image };
  }

  async create(taskId: string): Promise<Sandbox> {
    if (!SAFE_TASK_ID.test(taskId)) throw new Error(`invalid task id for a sandbox: ${taskId}`);
    const name = containerName(taskId);
    let info = await this.inspect(name);
    let created = false;
    if (!info) {
      await this.ensureNetwork();
      const r = await this.cli.run([
        'run',
        '-d',
        '--init',
        '--name',
        name,
        '--label',
        `${LABEL}=1`,
        '--label',
        `${TASK_LABEL}=${taskId}`,
        '--network',
        this.cfg.network,
        '--cpus',
        String(this.cfg.cpus),
        '--memory',
        this.cfg.memory,
        '--pids-limit',
        String(this.cfg.pids),
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        ...HOST_ALIASES.flatMap(alias => ['--add-host', `${alias}:127.0.0.1`]),
        '--mount',
        `type=volume,src=${volumeName(taskId)},dst=${WORKSPACE_ROOT}`,
        this.cfg.image,
      ]);
      if (r.exitCode === 0) {
        info = { containerId: decode(r.stdout).trim(), labeled: true, running: true };
        created = true;
      } else if (/is already in use/i.test(r.stderr)) {
        // Параллельный create той же задачи: контейнер уже создан другим вызовом.
        info = await this.inspect(name);
      }
      if (!info) throw new DockerError(['run', name], r.exitCode, r.stderr);
    }
    const sandbox = new DockerSandbox(name, taskId, info.containerId, this.cli, this.settings);
    try {
      if (!info.running) await sandbox.start();
      else {
        // Идемпотентно (старые правила снимаются): заодно чинит контейнер, запущенный в обход провайдера.
        await blockEgressOrStop(this.cli, this.cfg.image, info.containerId, name);
        await waitForBrowserd(this.cli, info.containerId, name, this.opts.healthAttempts);
      }
    } catch (err) {
      // Откатываем только то, что создали сами: чужой/ранее существовавший контейнер и его том не трогаем.
      if (created) await sandbox.destroy().catch(() => undefined);
      throw err;
    }
    return sandbox;
  }

  async get(sandboxId: string): Promise<Sandbox | undefined> {
    if (!sandboxId.startsWith(NAME_PREFIX)) return undefined;
    const info = await this.inspect(sandboxId);
    if (!info?.labeled) return undefined;
    return new DockerSandbox(sandboxId, sandboxId.slice(NAME_PREFIX.length), info.containerId, this.cli, this.settings);
  }

  async list(): Promise<SandboxInfo[]> {
    const out = await this.cli.ok(['ps', '-a', '--filter', `label=${LABEL}=1`, '--format', `{{.Names}}\t{{.State}}`]);
    return out
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const [id = '', state = ''] = line.split('\t');
        return { id, taskId: id.slice(NAME_PREFIX.length), running: state === 'running' };
      });
  }

  private async inspect(name: string): Promise<ContainerInfo | undefined> {
    const r = await this.cli.run([
      'inspect',
      '--type',
      'container',
      '--format',
      `{{.Id}}\t{{.State.Running}}\t{{index .Config.Labels "${LABEL}"}}`,
      name,
    ]);
    if (r.exitCode !== 0) {
      if (NO_SUCH_CONTAINER.test(r.stderr)) return undefined;
      throw new DockerError(['inspect', name], r.exitCode, r.stderr);
    }
    const [containerId = '', running = '', label = ''] = decode(r.stdout).trim().split('\t');
    return { containerId, labeled: label === '1', running: running === 'true' };
  }

  /**
   * Сеть песочниц — bridge с выключенным ICC: песочницы не видят друг друга. Старая сеть с включённым ICC
   * пересоздаётся, если к ней ничего не подключено (в том числе остановленные контейнеры: после
   * пересоздания они бы уже не запустились); иначе — SandboxNetworkError с инструкцией для оператора.
   */
  private ensureNetwork(): Promise<void> {
    const network = this.cfg.network;
    this.networkReady ??= (async () => {
      const exists = await this.cli.run(['network', 'inspect', '--format', '{{json .Options}}', network]);
      if (exists.exitCode === 0) {
        const options = JSON.parse(decode(exists.stdout).trim() || '{}') as Record<string, string> | null;
        if (options?.[ICC_OPTION] === 'false') return;
        const attached = (await this.cli.ok(['ps', '-a', '-q', '--filter', `network=${network}`]))
          .split('\n')
          .filter(Boolean).length;
        if (attached > 0) throw new SandboxNetworkError(network, attached);
        const removed = await this.cli.run(['network', 'rm', network]);
        if (removed.exitCode !== 0 && !/not found/i.test(removed.stderr)) {
          throw new DockerError(['network', 'rm'], removed.exitCode, removed.stderr);
        }
      }
      const created = await this.cli.run([
        'network',
        'create',
        '--driver',
        'bridge',
        '-o',
        `${ICC_OPTION}=false`,
        network,
      ]);
      if (created.exitCode !== 0 && !/already exists/i.test(created.stderr)) {
        throw new DockerError(['network', 'create'], created.exitCode, created.stderr);
      }
    })().catch(err => {
      this.networkReady = undefined; // не кэшируем сбой: следующий create попробует снова
      throw err;
    });
    return this.networkReady;
  }
}
