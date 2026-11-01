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
      waitUserTimeoutMs: 86_400_000,
    });
  });

  test('presigned URLs use S3_PUBLIC_ENDPOINT, falling back to S3_ENDPOINT', () => {
    expect(loadConfig(base).s3.publicEndpoint).toBe(base.S3_ENDPOINT);
    expect(loadConfig({ ...base, S3_PUBLIC_ENDPOINT: 'http://localhost:53900' }).s3.publicEndpoint).toBe(
      'http://localhost:53900',
    );
    expect(loadConfig({ ...base, S3_PUBLIC_ENDPOINT: '' }).s3.publicEndpoint).toBe(base.S3_ENDPOINT);
  });

  test('worker and db settings have defaults', () => {
    const c = loadConfig(base);
    expect(c.worker).toEqual({
      queuePrefix: 'bull',
      jobAttempts: 3,
      concurrency: 4,
      sweepEveryMs: 60_000,
      staleTaskMs: 120_000,
    });
    expect(c.db).toEqual({ lockTimeoutMs: 10_000 });
    expect(loadConfig({ ...base, QUEUE_PREFIX: 'test-1', DB_LOCK_TIMEOUT_MS: '2500' })).toMatchObject({
      worker: { queuePrefix: 'test-1' },
      db: { lockTimeoutMs: 2500 },
    });
  });

  test('model context windows and tool choice have defaults and can be overridden', () => {
    const c = loadConfig(base);
    expect(c.llm.contextTokens).toEqual({ planner: 64_000, executor: 32_000 });
    expect(c.llm.toolChoice).toBe('required');
    const o = loadConfig({ ...base, EXECUTOR_CONTEXT_TOKENS: '128000', LLM_TOOL_CHOICE: 'auto' });
    expect(o.llm.contextTokens.executor).toBe(128_000);
    expect(o.llm.toolChoice).toBe('auto');
    expect(() => loadConfig({ ...base, LLM_TOOL_CHOICE: 'none' })).toThrow(/LLM_TOOL_CHOICE/);
  });

  test('BRAVE_BASE_URL must be a URL', () => {
    expect(() => loadConfig({ ...base, BRAVE_BASE_URL: 'not a url' })).toThrow(/BRAVE_BASE_URL/);
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
      namespace: 'dev',
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
      SANDBOX_NAMESPACE: 'ns-x',
      BRAVE_API_KEY: 'brave-key',
      BRAVE_BASE_URL: 'http://localhost:9999',
    });
    expect(c.sandbox).toEqual({
      image: 'agent-sandbox:1',
      network: 'net-x',
      cpus: 1.5,
      memory: '512m',
      pids: 128,
      namespace: 'ns-x',
    });
    expect(c.search).toEqual({ braveApiKey: 'brave-key', braveBaseUrl: 'http://localhost:9999' });
  });

  test('empty BRAVE_API_KEY means search is not configured', () => {
    expect(loadConfig({ ...base, BRAVE_API_KEY: '' }).search.braveApiKey).toBeNull();
  });

  test('rejects malformed sandbox memory', () => {
    expect(() => loadConfig({ ...base, SANDBOX_MEMORY: 'lots' })).toThrow(/SANDBOX_MEMORY/);
  });

  test('model prices default to credits per 1M tokens and can be overridden', () => {
    expect(loadConfig(base).pricing).toEqual({
      planner: { inputPerMillion: 30, outputPerMillion: 120 },
      executor: { inputPerMillion: 30, outputPerMillion: 120 },
    });
    const c = loadConfig({ ...base, PLANNER_PRICE_IN: '27.5', EXECUTOR_PRICE_OUT: '0' });
    expect(c.pricing.planner.inputPerMillion).toBe(27.5);
    expect(c.pricing.executor.outputPerMillion).toBe(0);
  });

  test('an empty or blank price means unset, not free', () => {
    for (const blank of ['', '  ']) {
      const c = loadConfig({ ...base, PLANNER_PRICE_IN: blank, EXECUTOR_PRICE_OUT: blank });
      expect(c.pricing.planner.inputPerMillion).toBe(30);
      expect(c.pricing.executor.outputPerMillion).toBe(120);
    }
  });

  test('negative prices are rejected', () => {
    expect(() => loadConfig({ ...base, EXECUTOR_PRICE_IN: '-1' })).toThrow(/EXECUTOR_PRICE_IN/);
  });

  test('api and auth settings have defaults; OAuth apps are off without credentials', () => {
    const c = loadConfig(base);
    expect(c.api).toEqual({ port: 3000, uploadMaxBytes: 52_428_800, sseHeartbeatMs: 15_000 });
    expect(c.auth).toEqual({ secret: null, baseUrl: 'http://localhost:8080', google: null, github: null });
  });

  test('an OAuth app needs both its client id and secret', () => {
    const c = loadConfig({ ...base, GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret', GOOGLE_CLIENT_ID: '' });
    expect(c.auth.github).toEqual({ clientId: 'id', clientSecret: 'secret' });
    expect(c.auth.google).toBeNull();
    expect(() => loadConfig({ ...base, GOOGLE_CLIENT_ID: 'id' })).toThrow(/GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET/);
  });

  test('the auth secret must be at least 32 characters', () => {
    expect(() => loadConfig({ ...base, BETTER_AUTH_SECRET: 'short' })).toThrow(/BETTER_AUTH_SECRET/);
    expect(loadConfig({ ...base, BETTER_AUTH_SECRET: 'x'.repeat(32) }).auth.secret).toBe('x'.repeat(32));
  });
});
