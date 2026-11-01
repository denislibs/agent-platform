/** Очередь вызовов: каждый следующий начинается только после того, как предыдущий завершился (успешно или нет). */
export class CallQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    // fn вызывается внутри then: синхронное исключение тоже становится отклонённым промисом.
    const result = this.tail.then(fn);
    this.tail = result.catch(() => {});
    return result;
  }
}

/**
 * Обёртка над объектом, все методы которого асинхронные: каждый вызов метода встаёт в queue и
 * начинается только после завершения предыдущего вызова в этой очереди. Несколько объектов на одной
 * очереди сериализуются вместе. Не-функциональные свойства возвращаются как есть.
 * Метод обёрнутого объекта не должен вызывать другой метод на той же очереди — это взаимная блокировка.
 */
export function sequential<T extends object>(target: T, queue: CallQueue): T {
  const wrapped = new Map<PropertyKey, unknown>();
  return new Proxy(target, {
    get(obj, key) {
      const value: unknown = Reflect.get(obj, key, obj);
      if (typeof value !== 'function') return value;
      let fn = wrapped.get(key);
      if (!fn) {
        fn = (...args: unknown[]) => queue.run(() => Reflect.apply(value, obj, args) as Promise<unknown>);
        wrapped.set(key, fn);
      }
      return fn;
    },
  });
}
