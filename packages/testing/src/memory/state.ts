import { AsyncLocalStorage } from 'node:async_hooks';
import type { Clock, FileRecord, IdGenerator, Step, Subtask, Task, UsageInput } from '@agent/core';

export interface MemoryUser {
  id: string;
  email: string;
  /** Баланс в милликредитах. */
  millicredits: number;
}

function refill<K, V>(target: Map<K, V>, source: Map<K, V>): void {
  target.clear();
  for (const [k, v] of source) target.set(k, v);
}

export type InMemorySnapshot = Pick<InMemoryState, 'users' | 'tasks' | 'steps' | 'subtasks' | 'files' | 'usage'>;

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
  /** Метка текущего UnitOfWork.run в асинхронном контексте (см. InMemoryUnitOfWork и проверку в репозиториях). */
  readonly txScope = new AsyncLocalStorage<{ active: boolean; token: symbol }>();

  constructor({ clock, ids }: { clock: Clock; ids: IdGenerator }) {
    this.clock = clock;
    this.ids = ids;
  }

  seedUser(p: { id?: string; email?: string; millicredits?: number } = {}): string {
    const id = p.id ?? this.ids.uuid();
    this.users.set(id, { id, email: p.email ?? `${id}@test.dev`, millicredits: p.millicredits ?? 100_000 });
    return id;
  }

  /** Глубокая копия данных — для отката InMemoryUnitOfWork. */
  snapshot(): InMemorySnapshot {
    const { users, tasks, steps, subtasks, files, usage } = this;
    return structuredClone({ users, tasks, steps, subtasks, files, usage });
  }

  restore(s: InMemorySnapshot): void {
    refill(this.users, s.users);
    refill(this.tasks, s.tasks);
    refill(this.subtasks, s.subtasks);
    refill(this.files, s.files);
    this.steps.splice(0, this.steps.length, ...s.steps);
    this.usage.splice(0, this.usage.length, ...s.usage);
  }
}
