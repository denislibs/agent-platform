import IORedis from 'ioredis';

/** Тип соединения с Valkey: потребители (composition) не зависят от ioredis напрямую. */
export type RedisConnection = IORedis;

/** Соединение для BullMQ: maxRetriesPerRequest = null обязателен для воркеров (ждут Valkey, а не падают). */
export function redisConnection(url: string): RedisConnection {
  return new IORedis(url, { maxRetriesPerRequest: null });
}
