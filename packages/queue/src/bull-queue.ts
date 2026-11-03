import { Queue } from 'bullmq';
import type IORedis from 'ioredis';
import type { AgentJob, JobQueue } from '@agent/core';
import type { Config } from '@agent/shared';

export const AGENT_QUEUE = 'agent';
export const SWEEP_JOB = 'sweep';
const READY_WAIT_MS = 2000;

/** Очередь `agent` на BullMQ (спецификация 8). jobId = key: повторная постановка, пока job жив, игнорируется. */
export class BullJobQueue implements JobQueue {
  private readonly queue: Queue;

  constructor(deps: { redis: IORedis; config: Config }) {
    this.queue = new Queue(AGENT_QUEUE, {
      connection: deps.redis,
      prefix: deps.config.worker.queuePrefix,
      defaultJobOptions: {
        attempts: deps.config.worker.jobAttempts,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: true,
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    });
  }

  async enqueue(job: AgentJob, key: string): Promise<void> {
    await this.queue.add(job.kind, { taskId: job.taskId, kind: job.kind, cycle: job.cycle }, { jobId: key });
  }

  /**
   * Расписание сборщика: job 'sweep' каждые everyMs (upsertJobScheduler). Первый проход — через everyMs:
   * с одним `every` BullMQ запускает его сразу, и тестовый воркер с большим SWEEP_EVERY_MS всё равно собрал бы
   * чужие задачи общей базы и песочницы. Для существующего расписания startDate не действует.
   */
  async scheduleSweep(everyMs: number): Promise<void> {
    await this.queue.upsertJobScheduler(
      'sweeper',
      { every: everyMs, startDate: Date.now() + everyMs },
      { name: SWEEP_JOB, data: {} },
    );
  }

  /** Для тестов и диагностики. */
  counts(): Promise<Record<string, number>> {
    return this.queue.getJobCounts();
  }

  /**
   * Сначала дожидается готовности очереди (не дольше READY_WAIT_MS): закрытие посреди инициализации
   * обрывает её команды ошибкой «Connection is closed» вне цепочки промисов.
   */
  async close(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>(resolve => {
      timer = setTimeout(resolve, READY_WAIT_MS);
    });
    await Promise.race([
      this.queue.waitUntilReady().then(
        () => undefined,
        () => undefined,
      ),
      timeout,
    ]);
    clearTimeout(timer);
    await this.queue.close();
  }
}
