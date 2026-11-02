import type { RefObject } from 'preact';
import { useLayoutEffect } from 'preact/hooks';

/** Высота textarea по содержимому; верхний предел задаёт CSS (`max-height`). */
export function fitToContent(el: HTMLTextAreaElement): void {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

export function useAutosize(ref: RefObject<HTMLTextAreaElement>, value: unknown, enabled = true): void {
  useLayoutEffect(() => {
    if (enabled && ref.current) fitToContent(ref.current);
  }, [ref, value, enabled]);
}
