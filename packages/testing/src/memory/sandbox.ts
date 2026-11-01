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

/** Обработчик может не думать о лимите: двойник обрежет вывод сам (truncated — если обработчик обрезал сам). */
export type ExecHandlerResult = Omit<ExecResult, 'truncated'> & { truncated?: boolean };
export type ExecHandler = (
  cmd: string,
  opts: ExecOptions & { cwd: string },
  sandbox: InMemorySandbox,
) => ExecHandlerResult | Promise<ExecHandlerResult>;
export type BrowserHandler = (action: BrowserAction, sandbox: InMemorySandbox) => PageSnapshot | Promise<PageSnapshot>;
export interface SandboxHandlers {
  exec?: ExecHandler;
  browser?: BrowserHandler;
}

/** Имя скриншота, которое принимает browserd; другое он заменяет временем (здесь — скриншота нет). */
const SAFE_SHOT = /^[A-Za-z0-9_-]{1,64}$/;

const byPath = (a: FileEntry, b: FileEntry) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** Те же лимиты по умолчанию, что у Docker-адаптера. */
export interface InMemorySandboxLimits {
  maxExecOutputBytes: number;
  maxReadFileBytes: number;
}
export const DEFAULT_IN_MEMORY_SANDBOX_LIMITS: InMemorySandboxLimits = {
  maxExecOutputBytes: 1024 * 1024,
  maxReadFileBytes: 50 * 1024 * 1024,
};

/** Обрезает строку до limit байт UTF-8. */
function capBytes(text: string, limit: number): { text: string; cut: boolean } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= limit) return { text, cut: false };
  return { text: new TextDecoder().decode(bytes.subarray(0, limit)), cut: true };
}

/** Файловая система в памяти; команды и браузер — подставляемые обработчики из провайдера. */
export class InMemorySandbox implements Sandbox {
  readonly files = new Map<string, Uint8Array>();
  running = true;
  destroyed = false;

  constructor(
    readonly id: string,
    readonly taskId: string,
    private readonly provider: InMemorySandboxProvider,
  ) {}

  private ensureRunning(): void {
    if (this.destroyed) throw new NotFoundError('sandbox', this.id);
    if (!this.running) throw new SandboxError('not_running', `sandbox ${this.id} is stopped`);
  }

  async exec(cmd: string, opts: ExecOptions): Promise<ExecResult> {
    const cwd = resolveWorkspacePath(opts.cwd ?? WORKSPACE_ROOT);
    this.ensureRunning();
    if (cwd !== WORKSPACE_ROOT && !this.hasEntriesUnder(cwd)) throw new NotFoundError('file', toWorkspaceRelative(cwd));
    const handler = this.provider.handlers.exec;
    if (!handler) {
      return {
        stdout: '',
        stderr: `no exec handler scripted for: ${cmd}`,
        exitCode: 127,
        timedOut: false,
        truncated: false,
      };
    }
    const r = await handler(cmd, { ...opts, cwd, timeoutMs: Math.min(opts.timeoutMs, MAX_EXEC_TIMEOUT_MS) }, this);
    const limit = this.provider.limits.maxExecOutputBytes;
    const stdout = capBytes(r.stdout, limit);
    const stderr = capBytes(r.stderr, limit);
    return {
      stdout: stdout.text,
      stderr: stderr.text,
      exitCode: r.exitCode,
      timedOut: r.timedOut,
      truncated: Boolean(r.truncated) || stdout.cut || stderr.cut,
    };
  }

  async readFile(path: string): Promise<Uint8Array> {
    const abs = resolveWorkspacePath(path);
    this.ensureRunning();
    this.ensureNoFileAncestor('readFile', abs);
    const bytes = this.files.get(abs);
    if (!bytes) {
      if (this.hasEntriesUnder(abs)) throw new SandboxError('not_a_file', `${toWorkspaceRelative(abs)} is a folder`);
      throw new NotFoundError('file', toWorkspaceRelative(abs));
    }
    const limit = this.provider.limits.maxReadFileBytes;
    if (bytes.length > limit) {
      throw new SandboxError(
        'file_too_large',
        `file ${toWorkspaceRelative(abs)} is ${bytes.length} bytes, over the ${limit}-byte read limit`,
      );
    }
    return new Uint8Array(bytes);
  }

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    const abs = resolveWorkspacePath(path);
    this.ensureRunning();
    this.ensureNoFileAncestor('writeFile', abs);
    if (this.hasEntriesUnder(abs)) {
      throw new SandboxError('fs_error', `writeFile ${toWorkspaceRelative(abs)} failed: Is a directory`);
    }
    this.files.set(abs, typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data));
  }

  async list(path: string, depth: number): Promise<FileEntry[]> {
    const base = resolveWorkspacePath(path);
    this.ensureRunning();
    this.ensureNoFileAncestor('list', base);
    if (this.files.has(base)) return [];
    const prefix = `${base}/`;
    const keys = [...this.files.keys()].filter(k => k.startsWith(prefix));
    if (base !== WORKSPACE_ROOT && keys.length === 0) throw new NotFoundError('file', toWorkspaceRelative(base));
    const entries = new Map<string, FileEntry>();
    for (const abs of keys) {
      const parts = abs.slice(prefix.length).split('/');
      for (let i = 1; i <= Math.min(parts.length, Math.max(1, depth)); i++) {
        const p = `${prefix}${parts.slice(0, i).join('/')}`;
        const isFile = i === parts.length;
        entries.set(p, {
          path: toWorkspaceRelative(p),
          type: isFile ? 'file' : 'dir',
          size: isFile ? (this.files.get(abs)?.length ?? 0) : 0,
        });
      }
    }
    return [...entries.values()].toSorted(byPath);
  }

  /** Путь сквозь файл (`a.txt/b`, где a.txt — файл) — fs_error, как ENOTDIR у настоящей файловой системы. */
  private ensureNoFileAncestor(op: string, abs: string): void {
    for (let i = abs.indexOf('/', WORKSPACE_ROOT.length + 1); i !== -1; i = abs.indexOf('/', i + 1)) {
      if (this.files.has(abs.slice(0, i))) {
        throw new SandboxError('fs_error', `${op} ${toWorkspaceRelative(abs)} failed: Not a directory`);
      }
    }
  }

  /** Папки в памяти нет отдельно от файлов: она существует, пока под ней лежит хоть один файл. */
  private hasEntriesUnder(abs: string): boolean {
    const prefix = `${abs}/`;
    for (const key of this.files.keys()) if (key.startsWith(prefix)) return true;
    return false;
  }

  async browser(action: BrowserAction): Promise<PageSnapshot> {
    this.ensureRunning();
    const handler = this.provider.handlers.browser;
    if (!handler) throw new SandboxError('browser_unavailable', 'no browser handler scripted');
    const snapshot = await handler(action, this);
    // Как browserd: скриншот действия с допустимым shot лежит в .screenshots/<shot>.png.
    if (snapshot.screenshotPath !== undefined || action.shot === undefined || !SAFE_SHOT.test(action.shot)) {
      return snapshot;
    }
    return { ...snapshot, screenshotPath: `.screenshots/${action.shot}.png` };
  }

  async stop(): Promise<void> {
    if (this.destroyed) throw new NotFoundError('sandbox', this.id);
    this.running = false;
  }

  async start(): Promise<void> {
    if (this.destroyed) throw new NotFoundError('sandbox', this.id);
    this.running = true;
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.running = false;
    this.files.clear();
    this.provider.sandboxes.delete(this.id);
  }
}

export class InMemorySandboxProvider implements SandboxProvider {
  readonly sandboxes = new Map<string, InMemorySandbox>();
  readonly limits: InMemorySandboxLimits;

  constructor(
    public handlers: SandboxHandlers = {},
    limits: Partial<InMemorySandboxLimits> = {},
  ) {
    this.limits = { ...DEFAULT_IN_MEMORY_SANDBOX_LIMITS, ...limits };
  }

  async create(taskId: string): Promise<Sandbox> {
    const id = `agent-sbx-${taskId}`;
    const existing = this.sandboxes.get(id);
    if (existing) {
      existing.running = true;
      return existing;
    }
    const sandbox = new InMemorySandbox(id, taskId, this);
    this.sandboxes.set(id, sandbox);
    return sandbox;
  }

  async get(sandboxId: string): Promise<Sandbox | undefined> {
    return this.sandboxes.get(sandboxId);
  }

  async list(): Promise<SandboxInfo[]> {
    return [...this.sandboxes.values()].map(s => ({ id: s.id, taskId: s.taskId, running: s.running }));
  }
}
