import type { JobKind } from '@agent/shared';

export interface AgentJob {
  taskId: string;
  kind: JobKind;
}

/**
 * Очередь job агента (спецификация 8). Данные job — только { taskId, kind }: состояние читается из Postgres.
 * key — идемпотентность: пока job с этим key не завершён, повторная постановка ничего не делает.
 */
export interface JobQueue {
  enqueue(job: AgentJob, key: string): Promise<void>;
}
