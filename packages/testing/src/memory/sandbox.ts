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

export type ExecHandler = (
  cmd: string,
  opts: ExecOptions & { cwd: string },
  sandbox: InMemorySandbox,
) => ExecResult | Promise<ExecResult>;
export type BrowserHandler = (action: BrowserAction, sandbox: InMemorySandbox) => PageSnapshot | Promise<PageSnapshot>;
export interface SandboxHandlers {
  exec?: ExecHandler;
  browser?: BrowserHandler;
}

const byPath = (a: FileEntry, b: FileEntry) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

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
    const handler = this.provider.handlers.exec;
    if (!handler) return { stdout: '', stderr: `no exec handler scripted for: ${cmd}`, exitCode: 127, timedOut: false };
    return handler(cmd, { ...opts, cwd }, this);
  }

  async readFile(path: string): Promise<Uint8Array> {
    const abs = resolveWorkspacePath(path);
    this.ensureRunning();
    const bytes = this.files.get(abs);
    if (!bytes) throw new NotFoundError('file', toWorkspaceRelative(abs));
    return new Uint8Array(bytes);
  }

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    const abs = resolveWorkspacePath(path);
    this.ensureRunning();
    this.files.set(abs, typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data));
  }

  async list(path: string, depth: number): Promise<FileEntry[]> {
    const base = resolveWorkspacePath(path);
    this.ensureRunning();
    if (this.files.has(base)) return [];
    const prefix = `${base}/`;
    const keys = [...this.files.keys()].filter(k => k.startsWith(prefix));
    if (base !== WORKSPACE_ROOT && keys.length === 0) throw new NotFoundError('file', toWorkspaceRelative(base));
    const entries = new Map<string, FileEntry>();
    for (const abs of keys) {
      const parts = abs.slice(prefix.length).split('/');
      for (let i = 1; i <= Math.min(parts.length, depth); i++) {
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

  async browser(action: BrowserAction): Promise<PageSnapshot> {
    this.ensureRunning();
    const handler = this.provider.handlers.browser;
    if (!handler) throw new SandboxError('browser_failed', 'no browser handler scripted');
    return handler(action, this);
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

  constructor(public handlers: SandboxHandlers = {}) {}

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
