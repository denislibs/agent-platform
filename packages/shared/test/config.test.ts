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
});
