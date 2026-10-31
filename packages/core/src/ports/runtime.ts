export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  uuid(): string;
}
