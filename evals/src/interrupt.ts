export type InterruptSignal = 'SIGINT' | 'SIGTERM';

/** Источник сигналов: process в бою, EventEmitter в тестах. */
export interface SignalSource {
  on(signal: InterruptSignal, listener: () => void): unknown;
  off(signal: InterruptSignal, listener: () => void): unknown;
}

export interface Interrupts {
  /** Прерывается первым сигналом: прогон отменяет текущую задачу и больше задач не ставит. */
  readonly signal: AbortSignal;
  /** Каким сигналом прервали, если прервали. */
  readonly interruptedBy: InterruptSignal | undefined;
  dispose(): void;
}

/** Код выхода по сигналу, как у оболочки: 128 + номер сигнала. */
export const SIGNAL_EXIT_CODE: Record<InterruptSignal, number> = { SIGINT: 130, SIGTERM: 143 };

/**
 * Ctrl+C во время evals. Первый SIGINT/SIGTERM — мягкая остановка: прогон отменяет текущую задачу (иначе она осталась
 * бы running с живой песочницей), закрывает стек и пишет частичный отчёт. Второй — выход сразу, без уборки.
 */
export function watchInterrupts(
  source: SignalSource,
  opts: { log(message: string): void; exit(code: number): void },
): Interrupts {
  const controller = new AbortController();
  let interruptedBy: InterruptSignal | undefined;
  const listeners = (['SIGINT', 'SIGTERM'] as const).map(name => {
    const listener = () => {
      if (interruptedBy) {
        opts.log(`[evals] ${name} again: exiting now without cleanup`);
        opts.exit(SIGNAL_EXIT_CODE[name]);
        return;
      }
      interruptedBy = name;
      opts.log(`[evals] ${name}: cancelling the current task and writing a partial report (send it again to exit now)`);
      controller.abort();
    };
    source.on(name, listener);
    return [name, listener] as const;
  });
  return {
    signal: controller.signal,
    get interruptedBy() {
      return interruptedBy;
    },
    dispose() {
      for (const [name, listener] of listeners) source.off(name, listener);
    },
  };
}
