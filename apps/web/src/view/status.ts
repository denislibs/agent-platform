import type { PlanItem, PlanStatus, TaskItemStatus } from '@agent/ui';
import type { SubtaskDto, SubtaskStatus, TaskDetail, TaskStatus } from '@agent/shared';

// Таблицы — Record по всем статусам ядра: новый статус в @agent/shared не соберётся, пока его не добавят сюда.
// Читаются через Map: статус от более нового API (которого в типах ещё нет) даёт запасное значение, а не undefined.

/** Подзадача ядра → строка плана ui-kit (заметки плана 5 в дорожной карте). */
const PLAN_STATUS: Record<SubtaskStatus, PlanStatus> = {
  pending: 'pending',
  running: 'running',
  reviewing: 'running',
  accepted: 'done',
  failed: 'failed',
  skipped: 'skipped',
};

/** Задача ядра → значок задачи в сайдбаре. */
const TASK_ITEM_STATUS: Record<TaskStatus, TaskItemStatus> = {
  queued: 'running',
  planning: 'running',
  running: 'running',
  finalizing: 'running',
  waiting_user: 'waiting',
  done: 'done',
  failed: 'failed',
  cancelled: 'idle',
};

const PLAN_STATUS_MAP = new Map<string, PlanStatus>(Object.entries(PLAN_STATUS));
const TASK_ITEM_STATUS_MAP = new Map<string, TaskItemStatus>(Object.entries(TASK_ITEM_STATUS));

export const planStatus = (status: SubtaskStatus): PlanStatus => PLAN_STATUS_MAP.get(status) ?? 'pending';
export const taskItemStatus = (status: TaskStatus): TaskItemStatus => TASK_ITEM_STATUS_MAP.get(status) ?? 'idle';

/** План для PlanList: по порядку idx; описание — только у текущей подзадачи (что она должна сделать). */
export function planItems(subtasks: readonly SubtaskDto[]): PlanItem[] {
  return subtasks
    .toSorted((a, b) => a.idx - b.idx)
    .map(s => {
      const status = planStatus(s.status);
      return {
        id: s.id,
        title: s.goal,
        status,
        ...(status === 'running' && s.doneCriteria ? { description: s.doneCriteria } : {}),
      };
    });
}

/** Агент ещё работает (а не ждёт пользователя и не закончил): композер показывает «стоп». */
export const isWorking = (status: TaskStatus): boolean =>
  status === 'queued' || status === 'planning' || status === 'running' || status === 'finalizing';

/** Подпись индикатора «агент думает» по стадии. */
export function workingLabel(status: TaskStatus): string {
  switch (status) {
    case 'queued':
      return 'Starting…';
    case 'planning':
      return 'Planning…';
    case 'finalizing':
      return 'Wrapping up…';
    default:
      return 'Working…';
  }
}

/** Причины остановки (tasks.stop_reason) → текст для пользователя. */
const STOP_REASONS = new Map<string, string>([
  ['token_budget', 'it used up its token budget'],
  ['wall_time', 'it ran out of time'],
  ['credits', 'your credits ran out'],
  ['wait_timeout', 'nobody answered its question in time'],
]);

export function stopReasonText(reason: string | null): string {
  return (reason && STOP_REASONS.get(reason)) || 'it hit a limit';
}

/** Живой регион: статусы, кроме done (там зависит от partial). Record — чтобы новый статус не прошёл мимо. */
const ANNOUNCEMENTS: Record<Exclude<TaskStatus, 'done'>, string> = {
  queued: 'The task is queued.',
  planning: 'The agent is planning.',
  running: 'The agent is working.',
  waiting_user: 'The agent needs your answer.',
  finalizing: 'The agent is wrapping up.',
  failed: 'The task failed.',
  cancelled: 'The task was stopped.',
};

const ANNOUNCEMENT_MAP = new Map<string, string>(Object.entries(ANNOUNCEMENTS));

/** Текст живого региона: короткое объявление смены статуса для скринридера. */
export function statusAnnouncement(task: Pick<TaskDetail, 'status' | 'partial'>): string {
  if (task.status === 'done')
    return task.partial ? 'The task finished with a partial result.' : 'The task is complete.';
  return ANNOUNCEMENT_MAP.get(task.status) ?? 'The task status changed.';
}
