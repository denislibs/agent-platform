import { DelayedError, UnrecoverableError, Worker, type Job } from 'bullmq';
import { InvalidTransitionError, SandboxError, type AgentJob } from '@agent/core';
import type { JobRunner, Sweeper } from '@agent/agent';
import { AGENT_QUEUE, SWEEP_JOB, redisConnection, type BullJobQueue, type TaskLock } from '@agent/queue';
import type { Config } from '@agent/shared';

export const LOCK_RETRY_MS = 1000;

export interface WorkerDeps {
  config: Config;
  runner: JobRunner;
  sweeper: Sweeper;
  queue: BullJobQueue;
  taskLock: TaskLock;
}

export interface RunningWorker {
  close(): Promise<void>;
}

type AnyJob = Job<AgentJob | Record<string, never>>;

/** Выполнить fn под блокировкой задачи; undefined — блокировку держит другой job. */
async function withTaskLock<T>(
  lock: TaskLock,
  taskId: string,
  fn: () => Promise<T>,
): Promise<{ value: T } | undefined> {
  const token = await lock.acquire(taskId);
  if (!token) return undefined;
  const renew = setInterval(() => void lock.extend(taskId, token).catch(() => undefined), Math.floor(lock.ttl / 3));
  try {
    return { value: await fn() };
  } finally {
    clearInterval(renew);
    await lock.release(taskId, token);
  }
}

/** Ошибка программы или чужой контейнер на месте песочницы: повтор ничего не изменит. */
const isFatal = (err: unknown): boolean =>
  err instanceof InvalidTransitionError || (err instanceof SandboxError && err.code === 'foreign_container');

/** Воркер очереди agent (спецификация 8): один писатель на задачу, сборщик по расписанию. */
export async function startWorker(deps: WorkerDeps): Promise<RunningWorker> {
  const { config, runner, sweeper, queue, taskLock } = deps;
  // Своё соединение: блокирующие команды воркера не должны делить его с очередью и блокировками.
  const connection = redisConnection(config.valkeyUrl);

  const worker = new Worker(
    AGENT_QUEUE,
    async (job: AnyJob, token?: string) => {
      if (job.name === SWEEP_JOB) {
        const swept = await sweeper.sweep();
        if (swept.failed > 0) console.error('[worker] sweep finished with failures:', JSON.stringify(swept));
        return;
      }
      const data = job.data as AgentJob;
      try {
        const ran = await withTaskLock(taskLock, data.taskId, () => runner.run(data));
        if (ran) return;
      } catch (err) {
        if (isFatal(err)) throw new UnrecoverableError((err as Error).message);
        throw err;
      }
      // Задачу сейчас ведёт другой job: отложить, попытка не тратится.
      await job.moveToDelayed(Date.now() + LOCK_RETRY_MS, token);
      throw new DelayedError();
    },
    { connection, prefix: config.worker.queuePrefix, concurrency: config.worker.concurrency },
  );

  // Незавершённые onExhausted: close() дожидается их, пока соединения с базой и Valkey ещё открыты.
  const exhausting = new Set<Promise<void>>();
  // attemptsMade к событию failed уже увеличен (Job.moveToFailed), поэтому сравнение с attempts точное.
  worker.on('failed', (job: AnyJob | undefined, err: Error) => {
    if (!job) return;
    console.error(
      `[worker] job ${job.id} failed (attempt ${job.attemptsMade}/${job.opts.attempts ?? 1}):`,
      err.message,
    );
    if (job.name === SWEEP_JOB) return;
    const exhausted = err instanceof UnrecoverableError || job.attemptsMade >= (job.opts.attempts ?? 1);
    if (!exhausted) return;
    const data = job.data as AgentJob;
    // Блокировка занята — задачу ведёт другой job, валить её не нужно.
    const pending = withTaskLock(taskLock, data.taskId, () => runner.onExhausted(data, err))
      .then(() => undefined)
      .catch(e => console.error(`[worker] onExhausted failed for ${data.taskId}:`, e))
      .finally(() => exhausting.delete(pending));
    exhausting.add(pending);
  });
  worker.on('error', err => console.error('[worker] error:', err));

  await queue.scheduleSweep(config.worker.sweepEveryMs);
  await worker.waitUntilReady();

  return {
    async close() {
      await worker.close();
      await Promise.allSettled(exhausting);
      await connection.quit();
    },
  };
}
