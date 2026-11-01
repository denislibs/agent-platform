import type { AgentJob, JobQueue } from '@agent/core';

/** Очередь в памяти: job ждут, пока тест не возьмёт их через next(); key занят, пока job не взят. */
export class InMemoryJobQueue implements JobQueue {
  readonly jobs: Array<AgentJob & { key: string }> = [];

  async enqueue(job: AgentJob, key: string): Promise<void> {
    if (this.jobs.some(j => j.key === key)) return;
    this.jobs.push({ taskId: job.taskId, kind: job.kind, key });
  }

  /** Взять следующий job (как воркер); его key освобождается. */
  next(): (AgentJob & { key: string }) | undefined {
    return this.jobs.shift();
  }
}
