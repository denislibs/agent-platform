/** Таймеры как зависимость: тесты считают активные и проверяют, что после стрима не осталось ни одного. */
export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Ждёт промис не дольше `ms`: true — он завершился (успехом или ошибкой) вовремя, false — нет.
 * Сам промис не отменяется и не отклоняется наружу: его исход обрабатывает вызывающий.
 */
export async function settlesWithin(
  promise: Promise<unknown>,
  ms: number,
  timers: Timers = realTimers,
): Promise<boolean> {
  let handle: unknown;
  const timeout = new Promise<false>(resolve => {
    handle = timers.set(() => resolve(false), ms);
  });
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      timeout,
    ]);
  } finally {
    timers.clear(handle);
  }
}
