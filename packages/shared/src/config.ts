import { z } from 'zod';

const required = z.string().min(1);
const positiveInt = (def: number) => z.coerce.number().int().positive().default(def);
/** Пустая или пробельная строка — «не задано»: иначе z.coerce превратит '' в 0 и модель станет бесплатной. */
const blankAsUnset = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const price = (def: number) => z.preprocess(blankAsUnset, z.coerce.number().nonnegative().finite().default(def));

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
  /** Цены моделей в кредитах за 1M токенов (спецификация 11). */
  PLANNER_PRICE_IN: price(30),
  PLANNER_PRICE_OUT: price(120),
  EXECUTOR_PRICE_IN: price(30),
  EXECUTOR_PRICE_OUT: price(120),
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
  SANDBOX_IMAGE: z.string().min(1).default('agent-sandbox:dev'),
  SANDBOX_NETWORK: z.string().min(1).default('agent-sandbox'),
  SANDBOX_CPUS: z.coerce.number().positive().default(2),
  SANDBOX_MEMORY: z
    .string()
    .regex(/^\d+[kmg]$/i, 'expected a Docker memory size like 4g or 512m')
    .default('4g'),
  SANDBOX_PIDS: positiveInt(512),
  BRAVE_API_KEY: z.preprocess(v => (v === '' ? undefined : v), z.string().min(1).optional()),
  BRAVE_BASE_URL: z.url().default('https://api.search.brave.com'),
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
    pricing: {
      planner: { inputPerMillion: e.PLANNER_PRICE_IN, outputPerMillion: e.PLANNER_PRICE_OUT },
      executor: { inputPerMillion: e.EXECUTOR_PRICE_IN, outputPerMillion: e.EXECUTOR_PRICE_OUT },
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
    sandbox: {
      image: e.SANDBOX_IMAGE,
      network: e.SANDBOX_NETWORK,
      cpus: e.SANDBOX_CPUS,
      memory: e.SANDBOX_MEMORY,
      pids: e.SANDBOX_PIDS,
    },
    search: {
      braveApiKey: e.BRAVE_API_KEY ?? null,
      braveBaseUrl: e.BRAVE_BASE_URL,
    },
  };
}
