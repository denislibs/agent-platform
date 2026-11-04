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
      uploadTtlMs: 86_400_000,
      sandboxRetentionMs: 3_600_000,
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
    expect(() => loadConfig({})).toThrow(/DATABASE_URL.*S3_SECRET_ACCESS_KEY/s);
  });

  test('LiteLLM settings are optional (only the worker needs them); blank means unset', () => {
    const {
      LITELLM_BASE_URL: _url,
      LITELLM_API_KEY: _key,
      PLANNER_MODEL: _planner,
      EXECUTOR_MODEL: _executor,
      ...withoutLlm
    } = base;
    const c = loadConfig(withoutLlm);
    expect(c.llm).toMatchObject({ baseURL: null, apiKey: null, models: { planner: null, executor: null } });
    expect(loadConfig({ ...base, LITELLM_API_KEY: '' }).llm.apiKey).toBeNull();
    expect(loadConfig({ ...base, LITELLM_API_KEY: '  ' }).llm.apiKey).toBeNull();
    expect(loadConfig(base).llm).toMatchObject({ baseURL: 'http://llm/v1', apiKey: 'k' });
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
    expect(c.api).toEqual({
      host: '127.0.0.1',
      port: 3000,
      uploadMaxBytes: 52_428_800,
      sseHeartbeatMs: 15_000,
      sseMaxStreamMs: 900_000,
    });
    expect(loadConfig({ ...base, API_HOST: '0.0.0.0' }).api.host).toBe('0.0.0.0');
    expect(c.auth).toEqual({ secret: null, baseUrl: 'http://localhost:8080', google: null, github: null });
  });

  test('an OAuth app needs both its client id and secret', () => {
    const c = loadConfig({ ...base, GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret', GOOGLE_CLIENT_ID: '' });
    expect(c.auth.github).toEqual({ clientId: 'id', clientSecret: 'secret' });
    expect(c.auth.google).toBeNull();
    expect(() => loadConfig({ ...base, GOOGLE_CLIENT_ID: 'id' })).toThrow(/GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET/);
  });

  test('UPLOAD_TTL_MS is at least an hour: longer than the longest presigned PUT', () => {
    expect(loadConfig({ ...base, UPLOAD_TTL_MS: '3600000' }).worker.uploadTtlMs).toBe(3_600_000);
    expect(() => loadConfig({ ...base, UPLOAD_TTL_MS: '3599999' })).toThrow(/UPLOAD_TTL_MS/);
    expect(() => loadConfig({ ...base, UPLOAD_TTL_MS: '0' })).toThrow(/UPLOAD_TTL_MS/);
  });

  test('the SSE heartbeat is at most 2 minutes; the stream lifetime can be overridden', () => {
    expect(loadConfig({ ...base, SSE_HEARTBEAT_MS: '120000' }).api.sseHeartbeatMs).toBe(120_000);
    expect(() => loadConfig({ ...base, SSE_HEARTBEAT_MS: '120001' })).toThrow(/SSE_HEARTBEAT_MS/);
    expect(() => loadConfig({ ...base, SSE_HEARTBEAT_MS: '0' })).toThrow(/SSE_HEARTBEAT_MS/);
    expect(loadConfig({ ...base, SSE_MAX_STREAM_MS: '60000' }).api.sseMaxStreamMs).toBe(60_000);
    expect(() => loadConfig({ ...base, SSE_MAX_STREAM_MS: '-1' })).toThrow(/SSE_MAX_STREAM_MS/);
  });

  test('the auth secret must be at least 32 characters', () => {
    expect(() => loadConfig({ ...base, BETTER_AUTH_SECRET: 'short' })).toThrow(/BETTER_AUTH_SECRET/);
    expect(loadConfig({ ...base, BETTER_AUTH_SECRET: 'x'.repeat(32) }).auth.secret).toBe('x'.repeat(32));
  });
});

describe('mail', () => {
  test('no SMTP_URL — no provider; SMTP_URL with MAIL_FROM — the provider', () => {
    expect(loadConfig(base).mail).toEqual({ smtpUrl: null, from: null });
    expect(
      loadConfig({
        ...base,
        SMTP_URL: 'smtps://resend:re_key@smtp.resend.com:465',
        MAIL_FROM: 'Agent <noreply@example.com>',
      }).mail,
    ).toEqual({ smtpUrl: 'smtps://resend:re_key@smtp.resend.com:465', from: 'Agent <noreply@example.com>' });
  });

  test('half of the pair or a non-SMTP URL is a config error', () => {
    expect(() => loadConfig({ ...base, SMTP_URL: 'smtp://smtp.example.com:587' })).toThrow('SMTP_URL and MAIL_FROM');
    expect(() => loadConfig({ ...base, MAIL_FROM: 'noreply@example.com' })).toThrow('SMTP_URL and MAIL_FROM');
    expect(() => loadConfig({ ...base, SMTP_URL: 'https://api.resend.com', MAIL_FROM: 'a@b.c' })).toThrow('SMTP_URL');
  });
});

describe('blank values', () => {
  test('a blank value is unset for every variable: defaults apply (compose passes optional settings as ${VAR:-})', () => {
    const c = loadConfig({
      ...base,
      WORKER_CONCURRENCY: '',
      PLANNER_CONTEXT_TOKENS: ' ',
      LLM_TOOL_CHOICE: '',
      QUEUE_PREFIX: '',
      SANDBOX_IMAGE: '',
      MAX_ACTIVE_TASKS_PER_USER: '',
      SSE_HEARTBEAT_MS: '',
    });
    expect(c.worker.concurrency).toBe(4);
    expect(c.llm.contextTokens.planner).toBe(64_000);
    expect(c.llm.toolChoice).toBe('required');
    expect(c.worker.queuePrefix).toBe('bull');
    expect(c.sandbox.image).toBe('agent-sandbox:dev');
    expect(c.limits.maxActiveTasksPerUser).toBe(2);
    expect(c.api.sseHeartbeatMs).toBe(15_000);
  });

  test('a blank required variable is reported as missing', () => {
    expect(() => loadConfig({ ...base, DATABASE_URL: '  ' })).toThrow('DATABASE_URL');
  });
});

const secret = 'p'.repeat(32);
const authSecret = 'a'.repeat(32);
const previewApp = (url: string, host: string) => () =>
  loadConfig({ ...base, PREVIEW_SECRET: secret, BETTER_AUTH_URL: url, PREVIEW_HOST: host });

describe('preview settings', () => {
  test('previews are off without PREVIEW_HOST; a blank value is unset', () => {
    expect(loadConfig(base).preview).toBeNull();
    expect(loadConfig({ ...base, PREVIEW_HOST: ' ', BETTER_AUTH_SECRET: authSecret }).preview).toBeNull();
  });

  test('PREVIEW_HOST keeps the port for links and lowercases the name', () => {
    const c = loadConfig({ ...base, PREVIEW_HOST: 'Preview.LOCALHOST:8080', BETTER_AUTH_SECRET: authSecret });
    expect(c.preview).toEqual({ host: 'preview.localhost:8080', hostname: 'preview.localhost', secret: null });
  });

  test('PREVIEW_HOST is a bare host[:port]: no scheme, path or wildcard', () => {
    for (const host of ['http://preview.localhost', 'preview.localhost/x', '*.preview.localhost', 'a b', 'host:port'])
      expect(() => loadConfig({ ...base, PREVIEW_HOST: host, PREVIEW_SECRET: secret })).toThrow(/PREVIEW_HOST/);
  });

  test('previews need a key: PREVIEW_SECRET or BETTER_AUTH_SECRET', () => {
    expect(() => loadConfig({ ...base, PREVIEW_HOST: 'preview.localhost' })).toThrow(
      /PREVIEW_HOST needs PREVIEW_SECRET or BETTER_AUTH_SECRET/,
    );
    const c = loadConfig({ ...base, PREVIEW_HOST: 'preview.localhost', PREVIEW_SECRET: secret });
    expect(c.preview?.secret).toBe(secret);
    expect(() => loadConfig({ ...base, PREVIEW_SECRET: 'short' })).toThrow(/PREVIEW_SECRET/);
  });

  test('the app can live neither under the preview host nor above it; localhost is the one exception', () => {
    expect(previewApp('https://app.example.com', 'app.example.com')).toThrow(/same host/);
    expect(previewApp('https://app.example.com', 'example.com')).toThrow(/same host/);
    expect(previewApp('https://app.example.com', 'preview.app.example.com')).toThrow(/same host/);
    expect(previewApp('http://localhost:8080', 'preview.localhost:8080')).not.toThrow();
    expect(previewApp('https://app.example.com', 'example-usercontent.net')).not.toThrow();
  });
});
