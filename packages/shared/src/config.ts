import { z } from 'zod';

const required = z.string().min(1);
const positiveInt = (def: number) => z.coerce.number().int().positive().default(def);

const EnvSchema = z.object({
  DATABASE_URL: required,
  VALKEY_URL: required,
  S3_ENDPOINT: required,
  S3_REGION: required,
  S3_BUCKET: required,
  S3_ACCESS_KEY_ID: required,
  S3_SECRET_ACCESS_KEY: required,
  LITELLM_BASE_URL: required,
  LITELLM_API_KEY: required,
  PLANNER_MODEL: required,
  EXECUTOR_MODEL: required,
  MAX_SUBTASKS: positiveInt(12),
  MAX_EXECUTOR_STEPS: positiveInt(40),
  MAX_REVISIONS: positiveInt(2),
  MAX_REPLANS: positiveInt(3),
  TASK_TOKEN_BUDGET: positiveInt(2_000_000),
  TASK_WALL_TIME_MS: positiveInt(7_200_000),
  MAX_ACTIVE_TASKS_PER_USER: positiveInt(2),
  STEPS_PER_JOB: positiveInt(5),
  WORKER_CONCURRENCY: positiveInt(4),
  WAIT_USER_TIMEOUT_MS: positiveInt(86_400_000),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: Record<string, string | undefined> = process.env) {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${details}`);
  }
  const e = parsed.data;
  return {
    databaseUrl: e.DATABASE_URL,
    valkeyUrl: e.VALKEY_URL,
    s3: {
      endpoint: e.S3_ENDPOINT,
      region: e.S3_REGION,
      bucket: e.S3_BUCKET,
      accessKeyId: e.S3_ACCESS_KEY_ID,
      secretAccessKey: e.S3_SECRET_ACCESS_KEY,
    },
    llm: {
      baseURL: e.LITELLM_BASE_URL,
      apiKey: e.LITELLM_API_KEY,
      models: { planner: e.PLANNER_MODEL, executor: e.EXECUTOR_MODEL },
    },
    limits: {
      maxSubtasks: e.MAX_SUBTASKS,
      maxExecutorSteps: e.MAX_EXECUTOR_STEPS,
      maxRevisions: e.MAX_REVISIONS,
      maxReplans: e.MAX_REPLANS,
      taskTokenBudget: e.TASK_TOKEN_BUDGET,
      taskWallTimeMs: e.TASK_WALL_TIME_MS,
      maxActiveTasksPerUser: e.MAX_ACTIVE_TASKS_PER_USER,
      stepsPerJob: e.STEPS_PER_JOB,
      workerConcurrency: e.WORKER_CONCURRENCY,
      waitUserTimeoutMs: e.WAIT_USER_TIMEOUT_MS,
    },
  };
}
