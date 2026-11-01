import type { JobKind, TaskStatus } from '@agent/shared';

/** Идентификатор job (спецификация 8): точка вместо `:` — BullMQ не принимает `:` в своих id. */
export const jobKey = (taskId: string, kind: JobKind, seq: number): string => `${taskId}.${kind}.${seq}`;

/** Id песочницы задачи по контракту SandboxProvider. */
export const sandboxIdFor = (taskId: string): string => `agent-sbx-${taskId}`;

/** Какой job ведёт задачу дальше; undefined — задача ждёт пользователя или завершена. */
export function kindForStatus(status: TaskStatus, currentKind: JobKind | null): JobKind | undefined {
  switch (status) {
    case 'queued':
    case 'planning':
      return 'plan';
    case 'running':
      return currentKind === 'review' ? 'review' : 'execute';
    case 'finalizing':
      return 'finalize';
    default:
      return undefined;
  }
}
