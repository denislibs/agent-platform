import type { Clock, IdGenerator } from './ports/runtime';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class CryptoIds implements IdGenerator {
  uuid(): string {
    return crypto.randomUUID();
  }
}
