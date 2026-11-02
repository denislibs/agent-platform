import { parseArgs as parseNodeArgs } from 'node:util';
import { loadConfig, type Config } from '@agent/shared';

export const EVALS_USAGE = [
  'usage: bun run evals [--only id1,id2] [--repeat n] [--planner model] [--executor model] [--tool-choice auto|required]',
  '       bun run evals --list',
  '       bun run evals --compare <report.json> <report.json>',
].join('\n');

export interface EvalArgs {
  only: string[];
  repeat: number;
  planner?: string;
  executor?: string;
  toolChoice?: 'auto' | 'required';
  list: boolean;
  compare?: [string, string];
}

export class UsageError extends Error {
  constructor(message: string) {
    super(`${message}\n${EVALS_USAGE}`);
    this.name = 'UsageError';
  }
}

export function parseArgs(argv: readonly string[]): EvalArgs {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  const { values, positionals } = parsed;
  const repeat = Number(values.repeat ?? '1');
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 20) throw new UsageError('--repeat must be 1…20');
  const toolChoice = values['tool-choice'];
  if (toolChoice !== undefined && toolChoice !== 'auto' && toolChoice !== 'required')
    throw new UsageError('--tool-choice must be auto or required');
  if (values.compare && positionals.length !== 2) throw new UsageError('--compare needs two report.json paths');
  if (!values.compare && positionals.length > 0) throw new UsageError(`unexpected argument: ${positionals[0]}`);
  return {
    only: (values.only ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
    repeat,
    ...(values.planner ? { planner: values.planner } : {}),
    ...(values.executor ? { executor: values.executor } : {}),
    ...(toolChoice ? { toolChoice } : {}),
    list: values.list ?? false,
    ...(values.compare ? { compare: [positionals[0]!, positionals[1]!] as [string, string] } : {}),
  };
}

function parse(argv: readonly string[]) {
  return parseNodeArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      only: { type: 'string' },
      repeat: { type: 'string' },
      planner: { type: 'string' },
      executor: { type: 'string' },
      'tool-choice': { type: 'string' },
      list: { type: 'boolean' },
      compare: { type: 'boolean' },
    },
  });
}

/** База evals: EVALS_DATABASE_URL или база agent_evals на том же сервере, что DATABASE_URL. Только *_evals. */
export function evalsDatabaseUrl(env: Record<string, string | undefined>): string {
  const explicit = env.EVALS_DATABASE_URL?.trim();
  if (!explicit && !env.DATABASE_URL) throw new Error('DATABASE_URL is not set (see .env.example)');
  const url = new URL(explicit || env.DATABASE_URL!);
  if (!explicit) url.pathname = '/agent_evals';
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!/^[a-z0-9_]+_evals$/.test(name))
    throw new Error(`refusing to run evals on database "${name}": its name must end with _evals`);
  return url.toString();
}

/**
 * Конфиг прогона: модели ролей из флагов поверх PLANNER_MODEL / EXECUTOR_MODEL, своя база, своя очередь
 * (сборщик и воркер разработки её не видят), своё пространство имён песочниц, один job за раз.
 */
export function evalsConfig(env: Record<string, string | undefined>, args: EvalArgs): Config {
  return loadConfig({
    ...env,
    DATABASE_URL: evalsDatabaseUrl(env),
    QUEUE_PREFIX: `evals-${crypto.randomUUID()}`,
    SANDBOX_NAMESPACE: 'evals',
    WORKER_CONCURRENCY: '1',
    ...(args.planner ? { PLANNER_MODEL: args.planner } : {}),
    ...(args.executor ? { EXECUTOR_MODEL: args.executor } : {}),
    ...(args.toolChoice ? { LLM_TOOL_CHOICE: args.toolChoice } : {}),
  });
}
