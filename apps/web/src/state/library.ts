import { batch, signal } from '@preact/signals';
import type { FileCategory, FileDto } from '@agent/shared';
import type { Api } from '../api/client.ts';

export type LibraryFilter = FileCategory | 'all';

/** Файлы Library: фильтр, поиск, страницы по курсору. Состояние одного открытого экрана. */
export function createLibrary(api: Api) {
  const files = signal<FileDto[]>([]);
  const nextCursor = signal<string | null>(null);
  const loaded = signal(false);
  const loading = signal(false);
  const failure = signal<unknown>(null);
  const filter = signal<LibraryFilter>('all');
  const query = signal('');
  /** Номер последнего запроса: ответ на устаревший фильтр или поиск отбрасывается. */
  let latest = 0;

  /** Неудача смены фильтра или поиска: строки и курсор прежнего запроса к новому не относятся. */
  const dropRows = () =>
    batch(() => {
      files.value = [];
      nextCursor.value = null;
    });

  async function fetchPage(before?: string, onFailure?: () => void) {
    const mine = ++latest;
    loading.value = true;
    try {
      const page = await api.listFiles({
        category: filter.value === 'all' ? undefined : filter.value,
        q: query.value,
        before,
      });
      if (mine !== latest) return;
      batch(() => {
        // Уже показанные файлы (сдвиг из-за новых) не дублируются.
        const known = new Set(files.value.map(f => f.id));
        files.value = before ? [...files.value, ...page.files.filter(f => !known.has(f.id))] : page.files;
        nextCursor.value = page.nextCursor;
        loaded.value = true;
        failure.value = null;
      });
    } catch (err) {
      if (mine === latest) {
        failure.value = err;
        onFailure?.();
      }
    } finally {
      if (mine === latest) loading.value = false;
    }
  }

  return {
    files,
    nextCursor,
    loaded,
    loading,
    failure,
    filter,
    query,
    reload: () => fetchPage(),
    more: () => (nextCursor.value === null ? Promise.resolve() : fetchPage(nextCursor.value)),
    setFilter(next: LibraryFilter): Promise<void> {
      filter.value = next;
      return fetchPage(undefined, dropRows);
    },
    /** Новый поиск; та же строка (пробелы по краям не в счёт) запроса не шлёт. */
    search(text: string): Promise<void> {
      if (text.trim() === query.value) return Promise.resolve();
      query.value = text.trim();
      return fetchPage(undefined, dropRows);
    },
    /**
     * Удаляет файл на сервере и из списка; ошибка запроса пробрасывается, список не меняется. Список, который шёл
     * до удаления, отбрасывается: его ответ мог вернуть файл. Если такой запрос был, первая страница грузится заново.
     */
    async remove(id: string): Promise<void> {
      await api.deleteFile(id);
      const inFlight = loading.value;
      latest++;
      batch(() => {
        files.value = files.value.filter(f => f.id !== id);
        loading.value = false;
      });
      if (inFlight) await fetchPage();
    },
  };
}
