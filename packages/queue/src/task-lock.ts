import type IORedis from 'ioredis';

const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
const EXTEND = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;

/** Один писатель на задачу (контракт плана 3c): блокировка с токеном и временем жизни; снимает только владелец. */
export class TaskLock {
  private readonly ttlMs: number;

  constructor(private readonly deps: { redis: IORedis; ttlMs?: number }) {
    this.ttlMs = deps.ttlMs ?? 60_000;
  }

  private key(taskId: string): string {
    return `lock:task:${taskId}`;
  }

  /** Токен владельца или undefined, если задача занята. */
  async acquire(taskId: string): Promise<string | undefined> {
    const token = crypto.randomUUID();
    const ok = await this.deps.redis.set(this.key(taskId), token, 'PX', this.ttlMs, 'NX');
    return ok === 'OK' ? token : undefined;
  }

  async extend(taskId: string, token: string): Promise<boolean> {
    return (await this.deps.redis.eval(EXTEND, 1, this.key(taskId), token, String(this.ttlMs))) === 1;
  }

  async release(taskId: string, token: string): Promise<void> {
    await this.deps.redis.eval(RELEASE, 1, this.key(taskId), token);
  }

  get ttl(): number {
    return this.ttlMs;
  }
}
