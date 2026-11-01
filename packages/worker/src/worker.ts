import { DelayedError, UnrecoverableError, Worker, type Job } from 'bullmq';
import { InvalidTransitionError, SandboxError, type AgentJob } from '@agent/core';
import type { JobRunner, Sweeper } from '@agent/agent';
import { AGENT_QUEUE, SWEEP_JOB, redisConnection, type BullJobQueue, type TaskLock } from '@agent/queue';
import type { Config } from '@agent/shared';

export const LOCK_RETRY_MS = 1000;
/** Сколько раз failed-обработчик пробует выполнить onExhausted под блокировкой задачи. */
export const EXHAUST_ATTEMPTS = 5;

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
  // Потеря блокировки только пишется в лог: прервать стадию нечем, у runner пока нет AbortSignal.
  const renew = setInterval(
    () =>
      void lock.extend(taskId, token).then(
        ok => {
          if (!ok) console.error(`[worker] lost the lock of task ${taskId}: another job may now run it`);
        },
        err => console.error(`[worker] could not extend the lock of task ${taskId}:`, err),
      ),
    Math.floor(lock.ttl / 3),
  );
  try {
    return { value: await fn() };
  } finally {
    clearInterval(renew);
    // Ошибка снятия не должна подменить исход fn; блокировка истечёт сама по ttl.
    await lock.release(taskId, token).catch(err => console.error(`[worker] could not release task ${taskId}:`, err));
  }
}

/** Ошибка программы или чужой контейнер на месте песочницы: повтор ничего не изменит. */
const isFatal = (err: unknown): boolean =>
  err instanceof InvalidTransitionError || (err instanceof SandboxError && err.code === 'foreign_container');

/**
 * Последняя попытка job провалилась: onExhausted под блокировкой задачи, до EXHAUST_ATTEMPTS раз через LOCK_RETRY_MS.
 * Если он так и не выполнился (блокировка занята или он бросил), упавший job удаляется: иначе removeOnFail держит
 * его id 7 дней, и повторная постановка сборщика с тем же ключом молча отбрасывается — задача зависла бы.
 */
async function exhaust(deps: Pick<WorkerDeps, 'runner' | 'taskLock'>, job: AnyJob, err: Error): Promise<void> {
  const data = job.data as AgentJob;
  for (let attempt = 1; attempt <= EXHAUST_ATTEMPTS; attempt++) {
    try {
      if (await withTaskLock(deps.taskLock, data.taskId, () => deps.runner.onExhausted(data, err))) return;
    } catch (e) {
      console.error(`[worker] onExhausted failed for ${data.taskId} (attempt ${attempt}/${EXHAUST_ATTEMPTS}):`, e);
    }
    if (attempt < EXHAUST_ATTEMPTS) await Bun.sleep(LOCK_RETRY_MS);
  }
  console.error(
    `[worker] onExhausted never ran for ${data.taskId}; removing job ${job.id} so the sweeper can re-queue`,
  );
  await job.remove().catch(e => console.error(`[worker] could not remove job ${job.id}:`, e));
}

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
        if (Object.values(swept).some(n => n > 0)) console.log('[worker] sweep:', JSON.stringify(swept));
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

  // Незавершённые exhaust: close() дожидается их, пока соединения с базой и Valkey ещё открыты.
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
    const pending = exhaust({ runner, taskLock }, job, err)
      .catch(e => console.error(`[worker] exhausting job ${job.id} failed:`, e))
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
