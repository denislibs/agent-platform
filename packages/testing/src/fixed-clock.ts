import type { Clock, IdGenerator } from '@agent/core';

export class FixedClock implements Clock {
  private current: number;
  constructor(start: Date = new Date('2026-01-01T00:00:00.000Z')) {
    this.current = start.getTime();
  }
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current += ms;
  }
  set(d: Date): void {
    this.current = d.getTime();
  }
}

/** Детерминированные UUID: 00000000-0000-4000-8000-000000000001, …002, … */
export class SequentialIds implements IdGenerator {
  private n = 0;
  uuid(): string {
    this.n += 1;
    return `00000000-0000-4000-8000-${this.n.toString(16).padStart(12, '0')}`;
  }
}
