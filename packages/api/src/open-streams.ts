/**
 * Открытые SSE-потоки процесса. `server.stop()` ждёт, пока закроются все соединения, а стрим шагов сам не
 * закрывается, пока задача не финальная. Поэтому при остановке потоки закрываются явно: клиент (EventSource)
 * переподключится с Last-Event-ID к другому экземпляру API.
 */
export class OpenStreams {
  private readonly closers = new Set<() => void>();
  private closing = false;

  get size(): number {
    return this.closers.size;
  }

  /**
   * Учитывает поток; `close` должен его остановить. Результат — снять с учёта (поток закончился сам).
   * Поток, открытый уже во время остановки, закрывается сразу.
   */
  track(close: () => void): () => void {
    if (this.closing) {
      close();
      return () => {};
    }
    const entry = () => close();
    this.closers.add(entry);
    return () => {
      this.closers.delete(entry);
    };
  }

  /** Закрывает все потоки и все, что откроются позже. Результат — сколько было открыто. */
  closeAll(): number {
    this.closing = true;
    const all = [...this.closers];
    this.closers.clear();
    for (const close of all) close();
    return all.length;
  }
}
