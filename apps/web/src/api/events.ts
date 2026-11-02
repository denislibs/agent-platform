import { StepDtoSchema, StreamEndSchema, type StepDto, type StreamEnd } from '@agent/shared';

/** То, что нужно от EventSource: тесты подставляют свой источник. */
export interface EventSourceLike {
  readonly readyState: number;
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
}
export type EventSourceFactory = (url: string) => EventSourceLike;

/** EventSource.CLOSED: браузер сдался (ответ не 200) и сам переподключаться не будет. */
const CLOSED = 2;
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30_000;

/** JSON события; не JSON — undefined (такое событие пропускается). */
function parseData(event: MessageEvent<string>): unknown {
  try {
    return JSON.parse(event.data);
  } catch {
    return undefined;
  }
}

export interface TaskEventHandlers {
  /** Новый шаг: каждый seq — ровно один раз и по возрастанию (дубли отброшены, спецификация 10). */
  onStep(step: StepDto): void;
  /** Задача в финальном статусе, все шаги отправлены; поток закрыт и больше не откроется. */
  onEnd(end: StreamEnd): void;
  /** Связь потеряна (false) и восстановлена (true): приложение перечитывает задачу и сессию. */
  onConnection?(connected: boolean): void;
  /**
   * Сервер отказал в потоке (ответ не 200: 401 — сессия кончилась, 404 — задачи нет) — на каждый отказ, а не только
   * на первый: приложение перечитывает задачу и решает, закрыть ли поток. Сам модуль продолжает попытки.
   */
  onRefused?(): void;
}

export interface TaskEventsOptions extends TaskEventHandlers {
  taskId: string;
  /** Шаги до этого seq уже есть у клиента. */
  afterSeq?: number;
  createSource?: EventSourceFactory;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Живой поток шагов задачи (GET /api/tasks/:id/events). Сам EventSource переподключается после штатного закрытия
 * потока раз в 15 минут и шлёт Last-Event-ID. Этот модуль добавляет: отбрасывание дублей по seq, закрытие по end,
 * переподключение с ?after= после stream_error и после отказа сервера (CLOSED) — с задержкой до 30 с.
 */
export function openTaskEvents(opts: TaskEventsOptions): { close(): void } {
  const createSource = opts.createSource ?? ((url: string) => new EventSource(url));
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let lastSeq = opts.afterSeq ?? 0;
  let source: EventSourceLike | undefined;
  let timer: unknown;
  let retryMs = RETRY_MIN_MS;
  let closed = false;
  let connected = true;

  const setConnected = (value: boolean) => {
    if (value === connected) return;
    connected = value;
    opts.onConnection?.(value);
  };

  const stop = () => {
    source?.close();
    source = undefined;
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
  };

  const reconnectLater = () => {
    stop();
    setConnected(false);
    timer = setTimer(() => {
      timer = undefined;
      connect();
    }, retryMs);
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
  };

  function connect(): void {
    if (closed) return;
    const url = `/api/tasks/${encodeURIComponent(opts.taskId)}/events?after=${lastSeq}`;
    const current = createSource(url);
    source = current;
    // События заменённого или закрытого источника не значат ничего: иначе вышло бы второе подключение.
    const on = (type: string, listener: (event: MessageEvent<string>) => void) =>
      current.addEventListener(type, event => {
        if (current === source) listener(event);
      });
    on('open', () => {
      retryMs = RETRY_MIN_MS;
      setConnected(true);
    });
    on('step', event => {
      const parsed = StepDtoSchema.safeParse(parseData(event));
      if (!parsed.success || parsed.data.seq <= lastSeq) return;
      lastSeq = parsed.data.seq;
      opts.onStep(parsed.data);
    });
    on('end', event => {
      closed = true;
      stop();
      setConnected(true);
      opts.onEnd(StreamEndSchema.parse(parseData(event)));
    });
    // Сбой чтения на сервере: поток закрывается, переподключаемся сами с последним seq.
    on('stream_error', () => reconnectLater());
    // Сбой соединения. CONNECTING — EventSource переподключится сам (с Last-Event-ID); CLOSED — сдался, решаем мы.
    on('error', () => {
      if (current.readyState !== CLOSED) return setConnected(false);
      reconnectLater();
      opts.onRefused?.();
    });
  }

  connect();
  return {
    close() {
      closed = true;
      stop();
    },
  };
}
