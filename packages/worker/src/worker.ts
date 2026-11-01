import { DelayedError, UnrecoverableError, Worker, type Job } from 'bullmq';
import { InvalidTransitionError, SandboxError, type AgentJob, type TaskRepository } from '@agent/core';
import type { JobRunner, Sweeper } from '@agent/agent';
import { AGENT_QUEUE, SWEEP_JOB, redisConnection, type BullJobQueue, type TaskLock } from '@agent/queue';
import type { Config } from '@agent/shared';

export const LOCK_RETRY_MS = 1000;
/** Сколько раз failed-обработчик пробует выполнить onExhausted под блокировкой задачи. */
export const EXHAUST_ATTEMPTS = 5;
/**
 * Сколько раз BullMQ возвращает зависший job (процесс умер или event loop не продлил блокировку job), прежде чем
 * провалить его. По умолчанию 1: перезапуск воркера посреди долгого `shell` (до 30 минут) и ещё одна заминка
 * валили бы задачу. 3 — запас на перезапуски при деплое, но вечная карусель из-за job, роняющего процесс, исключена.
 */
export const MAX_STALLED_COUNT = 3;

export interface WorkerDeps {
  config: Config;
  runner: JobRunner;
  sweeper: Sweeper;
  tasks: TaskRepository;
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

const toError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));

/** Ошибка программы или чужой контейнер на месте песочницы: повтор ничего не изменит. */
const isFatal = (err: unknown): boolean =>
  err instanceof InvalidTransitionError || (err instanceof SandboxError && err.code === 'foreign_container');

/** Seq из id job вида `<taskId>.<kind>.<seq>` (jobKey); undefined — id другого вида. */
function seqOf(job: AnyJob, taskId: string): number | undefined {
  const parts = job.id?.split('.');
  if (parts?.length !== 3 || parts[0] !== taskId || !/^\d+$/.test(parts[2]!)) return undefined;
  return Number(parts[2]);
}

/**
 * Дубль цепочки: первый запуск job, чей ключ построен по устаревшему lastSeq. Такой job ставит сборщик, когда
 * долгий шаг не обновляет задачу, а живой job ещё идёт; дубль ждёт блокировку и получает её, когда тот закончил.
 * Пропускать его безопасно: шаги пишутся только там, где следом ставится job по новому lastSeq (внутри job, при
 * приёме задачи, в сборщике при таймауте ожидания), значит, другой job уже продвинул задачу и поставил своего
 * преемника (или остановил задачу). Без пропуска дубль выполнил бы стадию ещё раз и
 * запустил бы вторую цепочку, которая на временных ошибках могла бы исчерпать попытки и провалить здоровую задачу.
 * Повторы (attemptsMade > 0) и job после зависания (stalledCounter > 0) выполняются: их работа могла оборваться
 * на середине, и они сами продвинули lastSeq. Ключ сборщика для простаивающей задачи совпадает с её lastSeq.
 */
async function isSuperseded(tasks: TaskRepository, job: AnyJob, data: AgentJob): Promise<boolean> {
  if (job.attemptsMade !== 0 || job.stalledCounter !== 0) return false;
  const seq = seqOf(job, data.taskId);
  if (seq === undefined) return false;
  const task = await tasks.get(data.taskId);
  return task !== undefined && task.lastSeq !== seq;
}

/**
 * Провал, который failed-обработчику исчерпывать не надо: onExhausted уже выполнен процессором под блокировкой.
 * BullMQ передаёт в событие failed тот же объект ошибки, что бросил процессор.
 */
const exhaustedInProcessor = new WeakSet<Error>();

/**
 * Запасной путь для провалов, не прошедших через catch процессора (например, UnrecoverableError самого BullMQ
 * после MAX_STALLED_COUNT зависаний) или для onExhausted, бросившего там: onExhausted под блокировкой задачи,
 * до EXHAUST_ATTEMPTS раз через LOCK_RETRY_MS.
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
  const { config, runner, sweeper, tasks, queue, taskLock } = deps;
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
      // Внутри процессора attemptsMade ещё не учитывает текущую попытку: BullMQ увеличивает его в moveToFailed.
      const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      const ran = await withTaskLock(taskLock, data.taskId, async () => {
        try {
          if (await isSuperseded(tasks, job, data)) {
            console.debug(`[worker] job ${job.id} skipped: task ${data.taskId} has moved past its seq`);
            return;
          }
          await runner.run(data);
        } catch (err) {
          const fatal = isFatal(err);
          const failure = fatal ? new UnrecoverableError((err as Error).message) : toError(err);
          // Исчерпание решается здесь, пока блокировка задачи ещё наша: после её снятия другой job мог продвинуть
          // задачу, и onExhausted из failed-обработчика провалил бы здоровую задачу.
          if (fatal || lastAttempt) {
            try {
              await runner.onExhausted(data, err);
              exhaustedInProcessor.add(failure);
            } catch (e) {
              console.error(`[worker] onExhausted failed for ${data.taskId} under the job's lock:`, e);
            }
          }
          throw failure;
        }
      });
      if (ran) return;
      // Задачу сейчас ведёт другой job: отложить, попытка не тратится.
      await job.moveToDelayed(Date.now() + LOCK_RETRY_MS, token);
      throw new DelayedError();
    },
    {
      connection,
      prefix: config.worker.queuePrefix,
      concurrency: config.worker.concurrency,
      maxStalledCount: MAX_STALLED_COUNT,
    },
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
    if (job.name === SWEEP_JOB || exhaustedInProcessor.has(err)) return;
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
