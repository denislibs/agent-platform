import { describe, expect, test } from 'bun:test';
import { evalsConfig, evalsDatabaseUrl, parseArgs, UsageError } from '../src/cli';

const env = {
  DATABASE_URL: 'postgres://agent:agent@localhost:55432/agent',
  VALKEY_URL: 'redis://localhost:56379',
  S3_ENDPOINT: 'http://localhost:53900',
  S3_REGION: 'garage',
  S3_BUCKET: 'agent-files',
  S3_ACCESS_KEY_ID: 'k',
  S3_SECRET_ACCESS_KEY: 's',
  LITELLM_BASE_URL: 'http://litellm.test/v1',
  LITELLM_API_KEY: 'key',
  PLANNER_MODEL: 'deepseek',
  EXECUTOR_MODEL: 'qwen',
};

describe('parseArgs', () => {
  test('defaults: every task once, models from the environment', () => {
    expect(parseArgs([])).toEqual({ only: [], repeat: 1, list: false });
  });

  test('--only, --repeat, model roles and tool choice', () => {
    expect(
      parseArgs([
        '--only',
        'csv-a, scrape-b',
        '--repeat',
        '3',
        '--planner',
        'qwen-max',
        '--executor',
        'qwen-turbo',
        '--tool-choice',
        'auto',
      ]),
    ).toEqual({
      only: ['csv-a', 'scrape-b'],
      repeat: 3,
      planner: 'qwen-max',
      executor: 'qwen-turbo',
      toolChoice: 'auto',
      list: false,
    });
  });

  test('--list and --compare with two reports', () => {
    expect(parseArgs(['--list']).list).toBe(true);
    expect(parseArgs(['--compare', 'a/report.json', 'b/report.json']).compare).toEqual([
      'a/report.json',
      'b/report.json',
    ]);
  });

  test('bad input is a UsageError with the usage text', () => {
    for (const argv of [
      ['--repeat', '0'],
      ['--repeat', 'x'],
      ['--tool-choice', 'none'],
      ['--compare', 'a'],
      ['stray'],
      ['--nope'],
    ])
      expect(() => parseArgs(argv)).toThrow(UsageError);
    expect(() => parseArgs(['--repeat', '0'])).toThrow('usage: bun run evals');
  });
});

describe('evalsDatabaseUrl', () => {
  test('the agent_evals database next to DATABASE_URL, or EVALS_DATABASE_URL as is', () => {
    expect(evalsDatabaseUrl(env)).toBe('postgres://agent:agent@localhost:55432/agent_evals');
    expect(evalsDatabaseUrl({ ...env, EVALS_DATABASE_URL: 'postgres://u:p@db:5432/mine_evals' })).toBe(
      'postgres://u:p@db:5432/mine_evals',
    );
  });

  test('a database whose name does not end with _evals is refused', () => {
    expect(() => evalsDatabaseUrl({ ...env, EVALS_DATABASE_URL: 'postgres://u:p@db:5432/agent' })).toThrow(
      'must end with _evals',
    );
  });
});

describe('evalsConfig', () => {
  test('own database, queue and sandbox namespace, one job at a time; flags override the model roles', () => {
    const config = evalsConfig(env, { ...parseArgs(['--planner', 'qwen-max', '--tool-choice', 'auto']) });
    expect(config.databaseUrl).toEndWith('/agent_evals');
    expect(config.worker.queuePrefix).toStartWith('evals-');
    expect(config.worker.concurrency).toBe(1);
    expect(config.sandbox.namespace).toBe('evals');
    expect(config.llm.models).toEqual({ planner: 'qwen-max', executor: 'qwen' });
    expect(config.llm.toolChoice).toBe('auto');
  });
});
