import type { Clock, FileRecord, IdGenerator, Step, Subtask, Task, UsageInput } from '@agent/core';

export interface MemoryUser {
  id: string;
  email: string;
  credits: number;
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

  seedUser(p: { id?: string; email?: string; credits?: number } = {}): string {
    const id = p.id ?? this.ids.uuid();
    this.users.set(id, { id, email: p.email ?? `${id}@test.dev`, credits: p.credits ?? 100 });
    return id;
  }
}
