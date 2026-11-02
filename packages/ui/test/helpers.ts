import { waitFor } from '@testing-library/preact';

/**
 * Ждёт, пока элемент исчезнет. Неудачный expect() внутри waitFor в Bun дорог (diff и стек на
 * каждую проверку, а их десятки), поэтому условие проверяется без expect.
 */
export function gone(query: () => Element | null): Promise<void> {
  return waitFor(() => {
    if (query()) throw new Error('still in the document');
  });
}

const captureOf = (options: unknown) =>
  typeof options === 'boolean' ? options : Boolean((options as { capture?: boolean } | undefined)?.capture);

/**
 * Слушатели на window и document, добавленные после вызова и ещё не снятые. Методы подменяются
 * у самих объектов: в happy-dom у window (globalThis и defaultView) они свои, а не из EventTarget.prototype.
 */
export function trackGlobalListeners() {
  type Method = EventTarget['addEventListener'];
  const targets = [...new Set<EventTarget>([document, window, document.defaultView!])];
  const active: Array<{ target: EventTarget; type: string; listener: unknown; capture: boolean }> = [];
  const originals = targets.map(target => {
    const own = {
      add: Object.getOwnPropertyDescriptor(target, 'addEventListener'),
      remove: Object.getOwnPropertyDescriptor(target, 'removeEventListener'),
    };
    const add = target.addEventListener.bind(target);
    const remove = target.removeEventListener.bind(target);
    const tracked: { add: Method; remove: Method } = {
      add: (type, listener, options) => {
        active.push({ target, type, listener, capture: captureOf(options) });
        add(type, listener, options);
      },
      remove: (type, listener, options) => {
        const index = active.findIndex(
          entry =>
            entry.target === target &&
            entry.type === type &&
            entry.listener === listener &&
            entry.capture === captureOf(options),
        );
        if (index >= 0) active.splice(index, 1);
        remove(type, listener, options);
      },
    };
    Object.defineProperty(target, 'addEventListener', { configurable: true, writable: true, value: tracked.add });
    Object.defineProperty(target, 'removeEventListener', { configurable: true, writable: true, value: tracked.remove });
    return { target, own };
  });
  return {
    types: () => active.map(entry => entry.type).toSorted(),
    restore() {
      for (const { target, own } of originals) {
        for (const [name, descriptor] of [
          ['addEventListener', own.add],
          ['removeEventListener', own.remove],
        ] as const) {
          if (descriptor) Object.defineProperty(target, name, descriptor);
          else delete (target as unknown as Record<string, unknown>)[name];
        }
      }
    },
  };
}
