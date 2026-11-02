import type { EventSourceLike } from '../src/api/events.ts';

/** EventSource для тестов: события подаются вручную, открытые источники — в FakeEventSource.all. */
export class FakeEventSource implements EventSourceLike {
  static all: FakeEventSource[] = [];
  static reset() {
    FakeEventSource.all = [];
  }
  static get last(): FakeEventSource {
    return FakeEventSource.all.at(-1)!;
  }

  readyState = 0;
  closed = false;
  private readonly listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();

  constructor(readonly url: string) {
    FakeEventSource.all.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  emit(type: string, data: unknown = {}, id?: string): void {
    this.emitRaw(type, JSON.stringify(data), id);
  }

  /** Событие с сырым текстом data, как оно пришло по сети. */
  emitRaw(type: string, data: string, id?: string): void {
    const event = new MessageEvent<string>(type, { data, lastEventId: id ?? '' });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  open(): void {
    this.readyState = 1;
    this.emit('open');
  }

  /** Сбой соединения: readyState 0 — браузер переподключится сам, 2 — сдался. */
  fail(readyState: 0 | 2): void {
    this.readyState = readyState;
    for (const listener of this.listeners.get('error') ?? []) listener(new MessageEvent<string>('error'));
  }
}

/** Ручные таймеры: run() выполняет всё запланированное. */
export function manualTimers() {
  const pending = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  return {
    setTimer: (fn: () => void, ms: number) => {
      const id = next++;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimer: (id: unknown) => void pending.delete(id as number),
    delays: () => [...pending.values()].map(t => t.ms),
    run() {
      const due = [...pending.values()];
      pending.clear();
      for (const t of due) t.fn();
    },
  };
}
