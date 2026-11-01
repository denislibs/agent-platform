import {
  MAX_EXEC_TIMEOUT_MS,
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
import { DockerCli, DockerError, type CliResult, type RunOptions } from './docker-cli';
import { BrowserdResponseSchema } from './page-snapshot';
import { decodeUtf8Prefix } from './utf8';

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
/** curl: не удалось подключиться — browserd сейчас не слушает (например, перезапускается). */
const CURL_COULDNT_CONNECT = 7;
const NOT_RUNNING = /is not running|is paused|is restarting/i;
const NO_SUCH_CONTAINER = /no such (object|container)/i;
const NETWORK_NOT_FOUND = /network .* not found/i;
const CONTAINER_ID = /^[0-9a-f]{12,64}$/;

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
  private async execRaw(argv: string[], opts: RunOptions & { cwd?: string } = {}): Promise<CliResult> {
    const args = ['exec', '-i'];
    if (opts.cwd) args.push('-w', opts.cwd);
    args.push(this.containerId, ...argv);
    const r = await this.cli.run(args, {
      stdin: opts.stdin ?? '',
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.maxOutputBytes ? { maxOutputBytes: opts.maxOutputBytes } : {}),
    });
    if (r.exitCode !== 0 && DAEMON_ERROR.test(r.stderr)) {
      // Такой же текст может напечатать и сама команда: верим не stderr, а состоянию контейнера.
      const state = await this.cli.run([
        'inspect',
        '--type',
        'container',
        '--format',
        // Status, а не Running: у приостановленного контейнера Running = true, но exec в нём невозможен.
        '{{.State.Status}}',
        this.containerId,
      ]);
      if (state.exitCode !== 0 && NO_SUCH_CONTAINER.test(state.stderr)) throw new NotFoundError('sandbox', this.id);
      if (state.exitCode === 0 && decode(state.stdout).trim() !== 'running') {
        throw new SandboxError('not_running', `sandbox ${this.id} is stopped`);
      }
      if (state.exitCode !== 0) throw new DockerError(args, r.exitCode, r.stderr);
      // Контейнер жив и запущен: это вывод самой команды, а не ошибка Docker.
    }
    return r;
  }

  async exec(cmd: string, opts: ExecOptions): Promise<ExecResult> {
    const cwd = resolveWorkspacePath(opts.cwd ?? WORKSPACE_ROOT);
    const timeoutMs = Math.min(
      Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_EXEC_TIMEOUT_MS,
      MAX_EXEC_TIMEOUT_MS,
    );
    // Отдельная дешёвая проверка надёжнее разбора текста ошибки OCI («chdir to cwd … failed», код 127).
    if (cwd !== WORKSPACE_ROOT) {
      const probe = await this.execRaw(['test', '-d', cwd]);
      if (probe.exitCode !== 0) throw new NotFoundError('file', toWorkspaceRelative(cwd));
    }
    const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
    const pidFile = `/tmp/.agent-exec-${crypto.randomUUID()}.pid`;
    const started = Date.now();
    const r = await this.execRaw(['sh', '-c', EXEC_WRAPPER, 'sh', pidFile, String(seconds), 'bash', '-c', cmd], {
      cwd,
      stdin: opts.stdin ?? '',
      timeoutMs: timeoutMs + 15_000,
      maxOutputBytes: this.settings.maxExecOutputBytes,
    });
    // Убитый клиент docker не останавливает команду в контейнере: добиваем её группу процессов сами.
    if (r.truncated) {
      await this.cli.run(['exec', this.containerId, 'bash', '-c', EXEC_KILL, 'bash', pidFile], { timeoutMs: 10_000 });
    }
    const elapsed = Date.now() - started;
    const timedOut = !r.truncated && (r.exitCode === 124 || (r.exitCode === 137 && elapsed >= timeoutMs));
    const stdout = r.truncated ? decodeUtf8Prefix(r.stdout) : decode(r.stdout);
    return { stdout, stderr: r.stderr, exitCode: r.exitCode, timedOut, truncated: r.truncated };
  }

  async readFile(path: string): Promise<Uint8Array> {
    const abs = resolveWorkspacePath(path);
    const rel = toWorkspaceRelative(abs);
    const limit = this.settings.maxReadFileBytes;
    // Размер проверяется до чтения, в том же exec: большой файл не идёт через docker вовсе.
    const r = await this.execRaw(['sh', '-c', READ_FILE_SCRIPT, 'sh', abs, String(limit)], { maxOutputBytes: limit });
    const tooLarge = (size: string | undefined) =>
      new SandboxError(
        'file_too_large',
        `file ${rel} is ${size ? `${size} bytes` : 'larger than that'}, over the ${limit}-byte read limit; ` +
          'read it in parts with exec (head -c, tail -c)',
      );
    if (r.exitCode === READ_FILE_IS_DIR) throw new SandboxError('not_a_file', `${rel} is a folder`);
    if (r.exitCode === READ_FILE_TOO_LARGE) throw tooLarge(/too large: (\d+)/.exec(r.stderr)?.[1]);
    if (r.truncated) throw tooLarge(undefined); // файл вырос между stat и cat
    if (r.exitCode !== 0) {
      if (/No such file or directory/i.test(r.stderr)) throw new NotFoundError('file', rel);
      throw new Error(`readFile ${rel} failed: ${r.stderr.trim()}`);
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
    let r = await this.browserRequest(action);
    if (r.exitCode === CURL_COULDNT_CONNECT) {
      // browserd перезапускается супервизором: действие до него не дошло, повторить безопасно.
      try {
        await waitForBrowserd(this.cli, this.containerId, this.id);
      } catch (err) {
        if (err instanceof DockerError)
          throw new SandboxError('browser_unavailable', `browserd did not come back: ${err.message}`);
        throw err;
      }
      r = await this.browserRequest(action);
    }
    if (r.exitCode !== 0) {
      throw new SandboxError(
        'browser_unavailable',
        `browserd is unreachable (curl exit ${r.exitCode}): ${r.stderr.trim()}`,
      );
    }
    let json: unknown;
    try {
      json = JSON.parse(decode(r.stdout));
    } catch {
      throw new SandboxError('browser_unavailable', 'browserd returned a response that is not valid JSON');
    }
    const parsed = BrowserdResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new SandboxError('browser_unavailable', `unexpected browserd response: ${parsed.error.message}`);
    }
    const body = parsed.data;
    if (!body.ok) {
      throw new SandboxError(body.code === 'element_not_found' ? 'element_not_found' : 'browser_failed', body.error);
    }
    return body.snapshot;
  }

  private browserRequest(action: BrowserAction): Promise<CliResult> {
    return this.execRaw(
      [
        'curl',
        '-sS',
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
    // `docker rm -f` несуществующего контейнера завершается успешно, поэтому сначала проверяем ID:
    // контейнера нет (уничтожен, имя занято новой песочницей) — ни он, ни том `agent-ws-<taskId>` не наши.
    const found = await this.cli.run(['inspect', '--type', 'container', '--format', '{{.Id}}', this.containerId]);
    if (found.exitCode !== 0) {
      if (NO_SUCH_CONTAINER.test(found.stderr)) return;
      throw new DockerError(['inspect', this.containerId], found.exitCode, found.stderr);
    }
    const r = await this.cli.run(['rm', '-f', this.containerId]);
    if (r.exitCode !== 0 && !NO_SUCH_CONTAINER.test(r.stderr)) {
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
/** Подставляется вместо NaN, ±Infinity и timeoutMs ≤ 0 (спецификация 5.1: 120 с). */
export const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
/** Лимит каждого потока вывода exec. */
export const DEFAULT_MAX_EXEC_OUTPUT_BYTES = 1024 * 1024;
/** Лимит readFile. */
export const DEFAULT_MAX_READ_FILE_BYTES = 50 * 1024 * 1024;

/**
 * Обёртка exec: `timeout` создаёт свою группу процессов (её id = его pid), обёртка записывает этот pid
 * в файл, чтобы при обрезке вывода убить всю группу (EXEC_KILL). stdin передаётся через fd 3: фоновой
 * команде неинтерактивный shell иначе подставил бы /dev/null. Код выхода — код `timeout`.
 */
const EXEC_WRAPPER = [
  'f=$1; shift',
  'exec 3<&0',
  'timeout --kill-after=2 "$@" <&3 3<&- &',
  'echo $! > "$f"',
  'wait $!; rc=$?',
  'rm -f "$f"',
  'exit $rc',
].join('\n');
/** Убивает группу процессов команды по pid-файлу обёртки (подождав, если файл ещё не записан). */
const EXEC_KILL = [
  'for i in 1 2 3 4 5; do [ -s "$1" ] && break; sleep 0.1; done',
  'p=$(cat "$1" 2>/dev/null) && [ -n "$p" ] && kill -KILL -- "-$p" 2>/dev/null',
  'rm -f "$1"',
  'exit 0',
].join('\n');

const READ_FILE_TOO_LARGE = 3;
const READ_FILE_IS_DIR = 4;
const READ_FILE_SCRIPT = [
  `[ -d "$1" ] && { echo "is a directory" >&2; exit ${READ_FILE_IS_DIR}; }`,
  'size=$(stat -c %s -- "$1") || exit 1',
  `if [ "$size" -gt "$2" ]; then echo "too large: $size" >&2; exit ${READ_FILE_TOO_LARGE}; fi`,
  'exec cat -- "$1"',
].join('\n');

/** Что DockerSandbox берёт у провайдера. */
interface SandboxSettings {
  image: string;
  maxExecOutputBytes: number;
  maxReadFileBytes: number;
}

export interface DockerSandboxOptions {
  /** Попыток дождаться browserd при создании (по 250 мс между ними). */
  healthAttempts?: number;
  /** Лимит каждого потока вывода exec, по умолчанию 1 MiB. */
  maxExecOutputBytes?: number;
  /** Лимит readFile, по умолчанию 50 MiB. */
  maxReadFileBytes?: number;
}

/** Приоритет правил блокировки: после таблицы local (0), до main (32766). */
const EGRESS_RULE_PREF = '100';

/**
 * Ставит правила BLOCKED_EGRESS (плюс шлюз и подсеть) в сетевое пространство запущенной песочницы.
 * Делает это короткоживущий служебный контейнер с одной лишь NET_ADMIN, разделяющий сеть песочницы:
 * у самой песочницы capabilities нет, снять правила она не может. Правила живут, пока жив netns, —
 * поэтому их ставит каждый запуск через провайдер, а политики автоперезапуска у контейнера нет.
 * Идемпотентно и без окна: на работающей песочнице добавляются только недостающие правила, а устаревшие
 * снимаются уже после этого (повторный create() не открывает доступ даже на миллисекунды).
 */
async function blockEgress(cli: DockerCli, image: string, containerId: string, id: string): Promise<void> {
  const script = [
    'set -e',
    "gw=$(ip -4 route show default | awk '{print $3; exit}')",
    "subnet=$(ip -4 route show scope link proto kernel | awk '{print $1; exit}')",
    '[ -n "$gw" ] && [ -n "$subnet" ] || { echo "no default route or subnet" >&2; exit 1; }',
    // Целевой набор; /32 ip rule показывает без маски — нормализуем так же.
    `want=$(for d in "$@" "$subnet" "$gw/32"; do echo "\${d%/32}"; done)`,
    `have() { ip rule show pref ${EGRESS_RULE_PREF} | awk '$NF == "blackhole" { for (i = 1; i < NF; i++) if ($i == "to") print $(i + 1) }'; }`,
    // Сначала добавляем недостающее, и только потом снимаем устаревшее: набор ни в какой момент не неполон.
    'current=$(have)',
    // Параллельный помощник (create той же задачи) мог успеть раньше: «File exists» при добавлении и
    // «No such file» при удалении — не ошибка. Любая другая ошибка печатается и валит помощника.
    `for d in $want; do echo "$current" | grep -qxF "$d" || ip rule add pref ${EGRESS_RULE_PREF} to "$d" blackhole 2>/tmp/e || grep -q 'File exists' /tmp/e || { cat /tmp/e >&2; exit 1; }; done`,
    `for d in $(have); do echo "$want" | grep -qxF "$d" || ip rule del pref ${EGRESS_RULE_PREF} to "$d" blackhole 2>/tmp/e || grep -q 'No such file' /tmp/e || { cat /tmp/e >&2; exit 1; }; done`,
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
    private readonly opts: DockerSandboxOptions = {},
  ) {}

  private get settings(): SandboxSettings {
    return {
      image: this.cfg.image,
      maxExecOutputBytes: this.opts.maxExecOutputBytes ?? DEFAULT_MAX_EXEC_OUTPUT_BYTES,
      maxReadFileBytes: this.opts.maxReadFileBytes ?? DEFAULT_MAX_READ_FILE_BYTES,
    };
  }

  async create(taskId: string): Promise<Sandbox> {
    if (!SAFE_TASK_ID.test(taskId)) throw new Error(`invalid task id for a sandbox: ${taskId}`);
    const name = containerName(taskId);
    let info = await this.inspect(name);
    let created = false;
    let volumeCreated = false;
    if (!info) ({ info, created, volumeCreated } = await this.runContainer(taskId, name));
    // После runContainer тоже: имя мог занять не параллельный create, а чужой контейнер.
    if (!info.labeled) {
      throw new Error(`container ${name} exists but was not created by the sandbox provider (no ${LABEL} label)`);
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
      // Откатываем только то, что создал этот вызов: чужой/ранее существовавший контейнер не трогаем,
      // а уцелевший том (например, после prune контейнера и сети) хранит файлы пользователя.
      if (created) await this.rollback(info.containerId, taskId, volumeCreated);
      throw err;
    }
    return sandbox;
  }

  /** Best-effort: контейнер по ID; том — только если его создал этот вызов create(). */
  private async rollback(containerId: string, taskId: string, volumeCreated: boolean): Promise<void> {
    if (CONTAINER_ID.test(containerId)) await this.cli.run(['rm', '-f', containerId]).catch(() => undefined);
    if (volumeCreated) await this.cli.run(['volume', 'rm', '-f', volumeName(taskId)]).catch(() => undefined);
  }

  /**
   * `docker run` новой песочницы. Том создаётся заранее с метками (сборщик найдёт осиротевшие тома);
   * уже существующий том (файлы прежней жизни песочницы) переиспользуется и при откате не удаляется.
   * Если Docker успел создать контейнер, но не запустил его, контейнер (по напечатанному ID) убирается,
   * а том — только созданный этим вызовом; «network … not found» (сеть удалили после кэширования) —
   * повтор один раз с новой сетью.
   */
  private async runContainer(
    taskId: string,
    name: string,
  ): Promise<{ info: ContainerInfo; created: boolean; volumeCreated: boolean }> {
    const volumeCreated = (await this.cli.run(['volume', 'inspect', volumeName(taskId)])).exitCode !== 0;
    for (let attempt = 1; ; attempt++) {
      await this.ensureNetwork();
      await this.cli.ok([
        'volume',
        'create',
        '--label',
        `${LABEL}=1`,
        '--label',
        `${TASK_LABEL}=${taskId}`,
        volumeName(taskId),
      ]);
      const r = await this.cli.run(this.runArgs(taskId, name));
      const id = decode(r.stdout).trim();
      if (r.exitCode === 0) {
        return { info: { containerId: id, labeled: true, running: true }, created: true, volumeCreated };
      }
      if (/is already in use/i.test(r.stderr)) {
        // Параллельный create той же задачи: контейнер уже создан другим вызовом, его том не наш.
        const info = await this.waitForContainer(name);
        if (info) return { info, created: false, volumeCreated: false };
        throw new DockerError(['run', name], r.exitCode, r.stderr);
      }
      // По ID, а не по имени: имя мог успеть занять параллельный create, его контейнер не трогаем.
      if (CONTAINER_ID.test(id)) await this.cli.run(['rm', '-f', id]);
      if (attempt === 1 && NETWORK_NOT_FOUND.test(r.stderr)) {
        this.networkReady = undefined;
        continue;
      }
      if (volumeCreated) await this.cli.run(['volume', 'rm', '-f', volumeName(taskId)]);
      throw new DockerError(['run', name], r.exitCode, r.stderr);
    }
  }

  /**
   * Docker резервирует имя раньше, чем контейнер становится виден `inspect`: сразу после «is already in use»
   * inspect ещё может ответить «No such container». Ждём появления до 5 с.
   */
  private async waitForContainer(name: string): Promise<ContainerInfo | undefined> {
    for (let i = 0; i < 50; i++) {
      const info = await this.inspect(name);
      if (info) return info;
      await Bun.sleep(100);
    }
    return undefined;
  }

  private runArgs(taskId: string, name: string): string[] {
    return [
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
    ];
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
