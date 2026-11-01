import { decodeUtf8Prefix } from './utf8';

export interface CliResult {
  stdout: Uint8Array;
  stderr: string;
  exitCode: number;
  /** stdout или stderr превысил maxOutputBytes: поток обрезан до лимита, клиент docker убит. */
  truncated: boolean;
}

export interface RunOptions {
  stdin?: string | Uint8Array;
  timeoutMs?: number;
  /** Лимит на каждый поток. Сверх него сбор прекращается, процесс docker убивается (SIGKILL). */
  maxOutputBytes?: number;
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

/** Читает поток по кускам; на переполнении оставляет ровно `limit` байт и зовёт onOverflow. */
async function collect(stream: ReadableStream<Uint8Array>, limit: number, onOverflow: () => void): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.length > limit) {
        chunks.push(value.subarray(0, limit - size));
        size = limit;
        onOverflow();
        break;
      }
      chunks.push(value);
      size += value.length;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Тонкая обёртка над docker CLI: без shell, аргументы передаются как есть. */
export class DockerCli {
  constructor(private readonly bin = 'docker') {}

  async run(args: string[], opts: RunOptions = {}): Promise<CliResult> {
    const stdin = typeof opts.stdin === 'string' ? new TextEncoder().encode(opts.stdin) : opts.stdin;
    const proc = Bun.spawn([this.bin, ...args], {
      stdin: stdin ?? 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      ...(opts.timeoutMs ? { timeout: opts.timeoutMs, killSignal: 'SIGKILL' as const } : {}),
    });
    const limit = opts.maxOutputBytes ?? Number.POSITIVE_INFINITY;
    let truncated = false;
    const overflow = () => {
      if (truncated) return;
      truncated = true;
      proc.kill('SIGKILL');
    };
    const [stdout, stderr, exitCode] = await Promise.all([
      collect(proc.stdout, limit, overflow),
      collect(proc.stderr, limit, overflow),
      proc.exited,
    ]);
    // Обрезанный по байтам stderr не должен заканчиваться U+FFFD от разрезанного символа.
    const stderrText = truncated ? decodeUtf8Prefix(stderr) : new TextDecoder().decode(stderr);
    return { stdout, stderr: stderrText, exitCode, truncated };
  }

  async ok(args: string[], opts: RunOptions = {}): Promise<string> {
    const r = await this.run(args, opts);
    if (r.exitCode !== 0) throw new DockerError(args, r.exitCode, r.stderr);
    return new TextDecoder().decode(r.stdout).trim();
  }
}
