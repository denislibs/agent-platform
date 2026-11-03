import type { JobKind } from '@agent/shared';

export interface AgentJob {
  taskId: string;
  kind: JobKind;
  /**
   * Цикл задачи, в котором job поставлен: повтор или исчерпанный job старого цикла не должен трогать новый.
   * У job, поставленных до появления циклов, поля нет: такой job считается job'ом текущего цикла задачи.
   */
  cycle: number;
}

/**
 * Очередь job агента (спецификация 8). Данные job — только { taskId, kind, cycle }: состояние читается из Postgres.
 * key — идемпотентность: пока job с этим key не завершён, повторная постановка ничего не делает.
 */
export interface JobQueue {
  enqueue(job: AgentJob, key: string): Promise<void>;
}
