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
const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/;
const DAEMON_ERROR = /^Error response from daemon/i;
const NOT_RUNNING = /is not running|is paused|is restarting/i;
const NO_SUCH_CONTAINER = /no such (object|container)/i;

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

  async browser(_action: BrowserAction): Promise<PageSnapshot> {
    throw new SandboxError('browser_failed', 'browser is wired in a later step');
  }

  async stop(): Promise<void> {
    await this.lifecycle(['stop', '-t', '5', this.containerId]);
  }

  async start(): Promise<void> {
    await this.lifecycle(['start', this.containerId]);
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

async function waitForBrowserd(cli: DockerCli, containerId: string, id: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const r = await cli.run(['exec', containerId, 'curl', '-sf', '-m', '2', BROWSERD_HEALTH], { timeoutMs: 5_000 });
    if (r.exitCode === 0) return;
    if (DAEMON_ERROR.test(r.stderr)) {
      if (NO_SUCH_CONTAINER.test(r.stderr)) throw new NotFoundError('sandbox', id);
      if (NOT_RUNNING.test(r.stderr)) throw new SandboxError('not_running', `sandbox ${id} is stopped`);
    }
    await Bun.sleep(250);
  }
  throw new DockerError(['exec', containerId], 1, 'browserd did not become healthy in 20s');
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
  ) {}

  async create(taskId: string): Promise<Sandbox> {
    if (!SAFE_TASK_ID.test(taskId)) throw new Error(`invalid task id for a sandbox: ${taskId}`);
    const name = containerName(taskId);
    let info = await this.inspect(name);
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
        '--add-host',
        'host.docker.internal:127.0.0.1',
        '--mount',
        `type=volume,src=${volumeName(taskId)},dst=${WORKSPACE_ROOT}`,
        this.cfg.image,
      ]);
      if (r.exitCode === 0) {
        info = { containerId: decode(r.stdout).trim(), labeled: true, running: true };
      } else if (/is already in use/i.test(r.stderr)) {
        // Параллельный create той же задачи: контейнер уже создан другим вызовом.
        info = await this.inspect(name);
      }
      if (!info) throw new DockerError(['run', name], r.exitCode, r.stderr);
    }
    const sandbox = new DockerSandbox(name, taskId, info.containerId, this.cli);
    if (!info.running) await sandbox.start();
    else await waitForBrowserd(this.cli, info.containerId, name);
    return sandbox;
  }

  async get(sandboxId: string): Promise<Sandbox | undefined> {
    if (!sandboxId.startsWith(NAME_PREFIX)) return undefined;
    const info = await this.inspect(sandboxId);
    if (!info?.labeled) return undefined;
    return new DockerSandbox(sandboxId, sandboxId.slice(NAME_PREFIX.length), info.containerId, this.cli);
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

  private ensureNetwork(): Promise<void> {
    this.networkReady ??= (async () => {
      const exists = await this.cli.run(['network', 'inspect', this.cfg.network]);
      if (exists.exitCode === 0) return;
      const created = await this.cli.run(['network', 'create', '--driver', 'bridge', this.cfg.network]);
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
