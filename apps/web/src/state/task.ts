import { batch, signal } from '@preact/signals';
import { isTerminalTask, type FileDto, type StepDto, type SubtaskDto, type TaskDetail } from '@agent/shared';
import { ApiRequestError, type Api } from '../api/client.ts';
import { openTaskEvents, type TaskEventsOptions } from '../api/events.ts';

/** Управляющие сигналы инструментов, после которых меняются подзадачи или итог: карточку надо перечитать. */
const PLAN_CONTROLS = new Set(['create_plan', 'report', 'accept', 'revise', 'replan', 'finish']);

function changesTheTask(step: StepDto): boolean {
  const { payload } = step;
  if (payload.type === 'status') return true;
  return (
    payload.type === 'tool_result' &&
    typeof payload.control?.kind === 'string' &&
    PLAN_CONTROLS.has(payload.control.kind)
  );
}

/** Ответы, после которых поток не нужен: сессии нет (401), задача чужая (403) или её больше нет (404). */
const FATAL_STATUSES = new Set([401, 403, 404]);

/** Лента по seq: дубль отброшен, опоздавший шаг встаёт на своё место. */
function mergeStep(list: StepDto[], step: StepDto): StepDto[] {
  const last = list.at(-1);
  if (!last || last.seq < step.seq) return [...list, step];
  if (list.some(s => s.seq === step.seq)) return list;
  const at = list.findIndex(s => s.seq > step.seq);
  return [...list.slice(0, at), step, ...list.slice(at)];
}

/**
 * Через сколько показать, что связи нет. Сервер штатно закрывает поток раз в 15 минут, и EventSource переподключается
 * за секунды — плашка «Reconnecting…» не должна мигать на каждом таком закрытии.
 */
export const OFFLINE_NOTICE_MS = 5000;

export interface TaskStoreDeps {
  api: Api;
  /** Тесты подставляют свой поток. */
  openEvents?: (opts: TaskEventsOptions) => { close(): void };
  /** Таймер задержки пометки «нет связи»; тесты подставляют ручной. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Состояние экрана задачи на сигналах (спецификация 12): карточка задачи из GET /api/tasks/:id, лента шагов из SSE.
 * Шаг status или управляющий сигнал (план, отчёт, решение) перечитывает карточку — подзадачи, итог и файлы;
 * параллельные перечитывания схлопываются в одно следующее.
 */
export function createTaskStore(deps: TaskStoreDeps, taskId: string) {
  const task = signal<TaskDetail | null>(null);
  const subtasks = signal<SubtaskDto[]>([]);
  const files = signal<FileDto[]>([]);
  const steps = signal<StepDto[]>([]);
  /** Карточку не показать: первое чтение не удалось, сессии нет (401) или задачи нет (403, 404). */
  const error = signal<ApiRequestError | null>(null);
  /** Перечитать карточку не вышло (сеть, 5xx), но она есть и поток жив: показанное может отставать. */
  const stale = signal<ApiRequestError | null>(null);
  /** Сколько шагов пришло в непонятном виде и не показано. */
  const skippedSteps = signal(0);
  /** Поток на связи; false — переподключается дольше OFFLINE_NOTICE_MS (короткие обрывы не показываются). */
  const connected = signal(true);
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let offlineTimer: unknown;
  let stream: { close(): void } | undefined;
  let starting: Promise<void> | undefined;
  let refreshing: Promise<void> | undefined;
  let dirty = false;
  let disposed = false;

  function cancelOffline(): void {
    if (offlineTimer !== undefined) clearTimer(offlineTimer);
    offlineTimer = undefined;
  }

  /** Связь пропала: пометка — только если за OFFLINE_NOTICE_MS она не вернулась; вернулась — снять сразу. */
  function setConnected(value: boolean): void {
    if (value) {
      cancelOffline();
      connected.value = true;
    } else if (connected.value && offlineTimer === undefined) {
      offlineTimer = setTimer(() => {
        offlineTimer = undefined;
        connected.value = false;
      }, OFFLINE_NOTICE_MS);
    }
  }

  function closeStream(): void {
    stream?.close();
    stream = undefined;
    cancelOffline();
  }

  async function load(): Promise<void> {
    const res = await deps.api.getTask(taskId);
    if (disposed) return;
    batch(() => {
      task.value = res.task;
      subtasks.value = res.subtasks;
      files.value = res.files;
      error.value = null;
      stale.value = null;
    });
  }

  /** Перечитать карточку; вызов во время чтения ставит ещё одно чтение после него. */
  function refresh(): Promise<void> {
    if (refreshing) {
      dirty = true;
      return refreshing;
    }
    refreshing = (async () => {
      try {
        for (;;) {
          dirty = false;
          await load();
          if (!dirty || disposed) break;
        }
      } catch (err) {
        if (!disposed) {
          const failure = err instanceof ApiRequestError ? err : new ApiRequestError(0, 'network', String(err));
          const fatal = FATAL_STATUSES.has(failure.status);
          // Сессия кончилась или задачи нет: переподключаться бессмысленно (401 уже увёл приложение на вход).
          if (fatal) closeStream();
          // Временный сбой при показанной карточке — не ошибка экрана, а пометка «может отставать».
          if (fatal || !task.value) error.value = failure;
          else stale.value = failure;
        }
      } finally {
        refreshing = undefined;
      }
    })();
    return refreshing;
  }

  /**
   * Прочитать карточку и открыть поток. Повторный вызов, пока стор запускается или поток открыт, ничего не делает;
   * после неудачи (error) — повторяет попытку: так экран предлагает «Try again».
   */
  function start(): Promise<void> {
    if (disposed || stream) return Promise.resolve();
    starting ??= (async () => {
      try {
        await refresh();
        if (disposed || stream || error.value || !task.value) return;
        openStream();
      } finally {
        starting = undefined;
      }
    })();
    return starting;
  }

  function openStream(): void {
    // Шагов в карточке нет: поток с нуля отдаёт всю ленту, у финальной задачи — и сразу end.
    stream = (deps.openEvents ?? openTaskEvents)({
      taskId,
      afterSeq: 0,
      onStep: step => {
        steps.value = mergeStep(steps.value, step);
        if (changesTheTask(step)) void refresh();
      },
      // Статус в end не нужен (и может не прочитаться): итог, файлы и статус — из карточки.
      onEnd: () => void refresh(),
      onConnection: value => {
        setConnected(value);
        // Пропала связь: сразу (без задержки пометки) проверить задачу и сессию — 401 уведёт на вход, 404 — задачи нет.
        // Вернулась, а карточка отстала: перечитать.
        if (!value || stale.value) void refresh();
      },
      // Сервер отказывает в потоке снова и снова: каждый отказ — повод проверить сессию и задачу ещё раз.
      // Чтение, начатое потерей связи из того же отказа, уже это проверяет — второе в очередь не ставим.
      onRefused: () => void (refreshing ?? refresh()),
      onInvalidStep: () => void skippedSteps.value++,
    });
  }

  return {
    task,
    subtasks,
    files,
    steps,
    error,
    stale,
    skippedSteps,
    connected,
    start,
    refresh,
    /** Ответ на вопрос агента; questionSeq — пауза, на которую отвечаем. */
    async reply(text: string, questionSeq: number | undefined): Promise<void> {
      task.value = (await deps.api.reply(taskId, text, questionSeq)).task;
    },
    async cancel(): Promise<void> {
      task.value = (await deps.api.cancel(taskId)).task;
      await refresh();
    },
    get finished(): boolean {
      return task.value !== null && isTerminalTask(task.value.status);
    },
    dispose(): void {
      disposed = true;
      closeStream();
    },
  };
}

export type TaskStore = ReturnType<typeof createTaskStore>;
