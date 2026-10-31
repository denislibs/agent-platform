import { describe, expect, test } from 'bun:test';
import { loadConfig } from '@agent/shared';

const base = {
  DATABASE_URL: 'postgres://a:b@localhost:5432/x',
  VALKEY_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'http://localhost:3900',
  S3_REGION: 'garage',
  S3_BUCKET: 'files',
  S3_ACCESS_KEY_ID: 'GKtest',
  S3_SECRET_ACCESS_KEY: 'secret',
  LITELLM_BASE_URL: 'http://llm/v1',
  LITELLM_API_KEY: 'k',
  PLANNER_MODEL: 'deepseek',
  EXECUTOR_MODEL: 'qwen',
};

describe('loadConfig', () => {
  test('maps env to a typed config with default limits', () => {
    const c = loadConfig(base);
    expect(c.databaseUrl).toBe(base.DATABASE_URL);
    expect(c.llm.models).toEqual({ planner: 'deepseek', executor: 'qwen' });
    expect(c.s3.bucket).toBe('files');
    expect(c.limits).toEqual({
      maxSubtasks: 12,
      maxExecutorSteps: 40,
      maxRevisions: 2,
      maxReplans: 3,
      taskTokenBudget: 2_000_000,
      taskWallTimeMs: 7_200_000,
      maxActiveTasksPerUser: 2,
      stepsPerJob: 5,
      workerConcurrency: 4,
      waitUserTimeoutMs: 86_400_000,
    });
  });

  test('limits can be overridden and are coerced to numbers', () => {
    expect(loadConfig({ ...base, MAX_SUBTASKS: '5' }).limits.maxSubtasks).toBe(5);
  });

  test('lists every missing variable in one error', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL.*LITELLM_API_KEY/s);
  });

  test('rejects non-positive limits', () => {
    expect(() => loadConfig({ ...base, STEPS_PER_JOB: '0' })).toThrow(/STEPS_PER_JOB/);
  });

  test('sandbox and search sections have defaults', () => {
    const c = loadConfig(base);
    expect(c.sandbox).toEqual({
      image: 'agent-sandbox:dev',
      network: 'agent-sandbox',
      cpus: 2,
      memory: '4g',
      pids: 512,
    });
    expect(c.search).toEqual({ braveApiKey: null, braveBaseUrl: 'https://api.search.brave.com' });
  });

  test('sandbox and search values can be overridden', () => {
    const c = loadConfig({
      ...base,
      SANDBOX_IMAGE: 'agent-sandbox:1',
      SANDBOX_NETWORK: 'net-x',
      SANDBOX_CPUS: '1.5',
      SANDBOX_MEMORY: '512m',
      SANDBOX_PIDS: '128',
      BRAVE_API_KEY: 'brave-key',
      BRAVE_BASE_URL: 'http://localhost:9999',
    });
    expect(c.sandbox).toEqual({ image: 'agent-sandbox:1', network: 'net-x', cpus: 1.5, memory: '512m', pids: 128 });
    expect(c.search).toEqual({ braveApiKey: 'brave-key', braveBaseUrl: 'http://localhost:9999' });
  });

  test('empty BRAVE_API_KEY means search is not configured', () => {
    expect(loadConfig({ ...base, BRAVE_API_KEY: '' }).search.braveApiKey).toBeNull();
  });

  test('rejects malformed sandbox memory', () => {
    expect(() => loadConfig({ ...base, SANDBOX_MEMORY: 'lots' })).toThrow(/SANDBOX_MEMORY/);
  });
});
