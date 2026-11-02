import { useEffect } from 'preact/hooks';

export interface HotkeyOptions {
  /** ⌘ на macOS или Ctrl на остальных системах. */
  mod?: boolean;
  enabled?: boolean;
}

function isEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  );
}

/** Глобальная горячая клавиша. Без `mod` не срабатывает, пока пользователь печатает в поле. */
export function useHotkey(
  key: string,
  handler: (event: KeyboardEvent) => void,
  { mod = false, enabled = true }: HotkeyOptions = {},
): void {
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // Во время набора через IME клавиши принадлежат методу ввода.
      if (event.isComposing || event.key.toLowerCase() !== key.toLowerCase()) return;
      if (mod !== (event.metaKey || event.ctrlKey)) return;
      if (!mod && isEditable(event.target)) return;
      event.preventDefault();
      handler(event);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  });
}
