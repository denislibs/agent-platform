import { batch, signal } from '@preact/signals';
import type { TaskSummary } from '@agent/shared';
import { ApiRequestError, type Api } from '../api/client.ts';

/** Список задач сайдбара: первая страница, «Load more» по курсору, обновление одной задачи на месте. */
export function createTaskList(api: Api) {
  const items = signal<TaskSummary[]>([]);
  const nextCursor = signal<string | null>(null);
  const loading = signal(false);
  /** Первая страница пришла: до этого «No tasks yet» не показывается. */
  const loaded = signal(false);
  const error = signal<ApiRequestError | null>(null);

  async function fetchPage(before: string | undefined, merge: (page: TaskSummary[]) => TaskSummary[]) {
    loading.value = true;
    try {
      const page = await api.listTasks(before);
      batch(() => {
        items.value = merge(page.tasks);
        nextCursor.value = page.nextCursor;
        loaded.value = true;
        error.value = null;
      });
    } catch (err) {
      if (err instanceof ApiRequestError) error.value = err;
    } finally {
      loading.value = false;
    }
  }

  return {
    items,
    nextCursor,
    loading,
    loaded,
    error,
    /** Первая страница заново; уже подгруженные «старые» страницы отбрасываются. */
    reload: () => fetchPage(undefined, page => page),
    /** Следующая страница; задачи, которые уже есть (сдвиг из-за новых задач), не дублируются. */
    async more(): Promise<void> {
      if (nextCursor.value === null || loading.value) return;
      await fetchPage(nextCursor.value, page => {
        const known = new Set(items.value.map(t => t.id));
        return [...items.value, ...page.filter(t => !known.has(t.id))];
      });
    },
    /**
     * Известная задача заменяется на месте (статус с экрана задачи). Неизвестная встаёт по времени создания — список
     * идёт от новых к старым: новее первой — в начало, между загруженными — на своё место. Старше всех загруженных —
     * только когда страниц больше нет; иначе она придёт с «Load more» (старая задача, открытая по ссылке, не прыгает
     * наверх).
     */
    upsert(task: TaskSummary): void {
      const list = items.value;
      if (list.some(t => t.id === task.id)) {
        items.value = list.map(t => (t.id === task.id ? task : t));
        return;
      }
      const created = Date.parse(task.createdAt);
      const at = list.findIndex(t => Date.parse(t.createdAt) < created);
      if (at !== -1) items.value = [...list.slice(0, at), task, ...list.slice(at)];
      else if (nextCursor.value === null) items.value = [...list, task];
    },
    /** Удаляет задачу на сервере и из списка; ошибка запроса пробрасывается, список не меняется. */
    async remove(id: string): Promise<void> {
      await api.deleteTask(id);
      items.value = items.value.filter(t => t.id !== id);
    },
    clear(): void {
      batch(() => {
        items.value = [];
        nextCursor.value = null;
        loaded.value = false;
      });
    },
  };
}

export type TaskList = ReturnType<typeof createTaskList>;
