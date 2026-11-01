import type { StepEvents } from '@agent/core';

type Handler = (lastSeq: number) => void;

/** Уведомления в памяти: доставка асинхронная (микрозадача), как у настоящего pub/sub. */
export class InMemoryStepEvents implements StepEvents {
  readonly published: Array<{ taskId: string; lastSeq: number }> = [];
  private readonly handlers = new Map<string, Set<Handler>>();

  async publish(taskId: string, lastSeq: number): Promise<void> {
    this.published.push({ taskId, lastSeq });
    for (const handler of this.handlers.get(taskId) ?? []) queueMicrotask(() => handler(lastSeq));
  }

  async subscribe(taskId: string, onNotify: Handler): Promise<() => Promise<void>> {
    let set = this.handlers.get(taskId);
    if (!set) {
      set = new Set();
      this.handlers.set(taskId, set);
    }
    // Своя обёртка на каждую подписку: одна и та же функция может быть подписана дважды.
    const entry: Handler = seq => onNotify(seq);
    set.add(entry);
    return async () => {
      const current = this.handlers.get(taskId);
      current?.delete(entry);
      if (current?.size === 0) this.handlers.delete(taskId);
    };
  }

  subscribers(taskId: string): number {
    return this.handlers.get(taskId)?.size ?? 0;
  }
}
