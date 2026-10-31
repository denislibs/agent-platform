export interface CliResult {
  stdout: Uint8Array;
  stderr: string;
  exitCode: number;
}

export class DockerError extends Error {
  constructor(
    readonly args: string[],
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super(`docker ${args.slice(0, 2).join(' ')} failed (${exitCode}): ${stderr.trim()}`);
    this.name = 'DockerError';
  }
}

/** Тонкая обёртка над docker CLI: без shell, аргументы передаются как есть. */
export class DockerCli {
  constructor(private readonly bin = 'docker') {}

  async run(args: string[], opts: { stdin?: string | Uint8Array; timeoutMs?: number } = {}): Promise<CliResult> {
    const stdin = typeof opts.stdin === 'string' ? new TextEncoder().encode(opts.stdin) : opts.stdin;
    const proc = Bun.spawn([this.bin, ...args], {
      stdin: stdin ?? 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      ...(opts.timeoutMs ? { timeout: opts.timeoutMs, killSignal: 'SIGKILL' as const } : {}),
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).bytes(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  }

  async ok(args: string[], opts: { stdin?: string | Uint8Array; timeoutMs?: number } = {}): Promise<string> {
    const r = await this.run(args, opts);
    if (r.exitCode !== 0) throw new DockerError(args, r.exitCode, r.stderr);
    return new TextDecoder().decode(r.stdout).trim();
  }
}
