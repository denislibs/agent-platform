import type { Clock, FileRecord, IdGenerator, Step, Subtask, Task, UsageInput } from '@agent/core';

export interface MemoryUser {
  id: string;
  email: string;
  /** Баланс в милликредитах. */
  millicredits: number;
}

/** Общее состояние всех in-memory адаптеров — аналог одной базы данных. */
export class InMemoryState {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly users = new Map<string, MemoryUser>();
  readonly tasks = new Map<string, Task>();
  readonly steps: Step[] = [];
  readonly subtasks = new Map<string, Subtask>();
  readonly files = new Map<string, FileRecord>();
  readonly usage: Array<UsageInput & { createdAt: Date }> = [];

  constructor({ clock, ids }: { clock: Clock; ids: IdGenerator }) {
    this.clock = clock;
    this.ids = ids;
  }

  seedUser(p: { id?: string; email?: string; millicredits?: number } = {}): string {
    const id = p.id ?? this.ids.uuid();
    this.users.set(id, { id, email: p.email ?? `${id}@test.dev`, millicredits: p.millicredits ?? 100_000 });
    return id;
  }
}
