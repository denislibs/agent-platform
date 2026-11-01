import type { StepEvents } from '@agent/core';
import type { RedisConnection } from './connection';

type Handler = (lastSeq: number) => void;

/** Канал уведомлений задачи (спецификация 10). */
export const stepChannel = (taskId: string): string => `task:${taskId}`;

/** Предел ожидания PUBLISH: при недоступном Valkey offline queue ioredis держит команду бесконечно. */
const DEFAULT_PUBLISH_TIMEOUT_MS = 1000;

interface Channel {
  handlers: Set<Handler>;
  /** SUBSCRIBE этого канала: следующие подписчики ждут его, а не возвращаются раньше времени. */
  ready: Promise<unknown>;
}

/**
 * StepEvents на Valkey pub/sub. Публикация — общим соединением; подписки — одним отдельным соединением
 * на процесс (в режиме subscriber соединение не выполняет других команд), по одному SUBSCRIBE на канал
 * со счётчиком подписчиков.
 *
 * Публикация ограничена по времени (`publishTimeoutMs`): запись шага и HTTP-запрос не должны зависать на
 * недоступном Valkey. По таймауту publish отклоняется, вызывающий (декоратор) пишет предупреждение, а подписчики
 * дочитают ленту по сердцебиению. Сама команда остаётся в очереди ioredis и уйдёт при восстановлении связи:
 * лишнее уведомление безвредно, подписчик всё равно перечитывает шаги из Postgres.
 */
export class ValkeyStepEvents implements StepEvents {
  private subscriber: RedisConnection | undefined;
  private readonly channels = new Map<string, Channel>();
  private readonly publishTimeoutMs: number;

  constructor(private readonly deps: { redis: RedisConnection; publishTimeoutMs?: number }) {
    this.publishTimeoutMs = deps.publishTimeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS;
  }

  async publish(taskId: string, lastSeq: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`publish timed out after ${this.publishTimeoutMs} ms`)),
        this.publishTimeoutMs,
      );
    });
    try {
      await Promise.race([this.deps.redis.publish(stepChannel(taskId), String(lastSeq)), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async subscribe(taskId: string, onNotify: Handler): Promise<() => Promise<void>> {
    const name = stepChannel(taskId);
    let channel = this.channels.get(name);
    if (!channel) {
      channel = { handlers: new Set(), ready: this.connection().subscribe(name) };
      this.channels.set(name, channel);
    }
    const entry: Handler = seq => onNotify(seq);
    channel.handlers.add(entry);
    await channel.ready;
    let done = false;
    return async () => {
      if (done) return;
      done = true;
      const current = this.channels.get(name);
      if (!current) return;
      current.handlers.delete(entry);
      if (current.handlers.size > 0) return;
      this.channels.delete(name);
      await this.subscriber?.unsubscribe(name);
    };
  }

  async close(): Promise<void> {
    this.channels.clear();
    const sub = this.subscriber;
    this.subscriber = undefined;
    if (sub) await sub.quit();
  }

  private connection(): RedisConnection {
    if (!this.subscriber) {
      const sub = this.deps.redis.duplicate();
      sub.on('message', (channel: string, message: string) => {
        const seq = Number(message);
        if (!Number.isSafeInteger(seq)) return;
        for (const handler of this.channels.get(channel)?.handlers ?? []) handler(seq);
      });
      this.subscriber = sub;
    }
    return this.subscriber;
  }
}
