import { useEffect } from 'preact/hooks';
import { isComposing } from './ime.ts';

export interface HotkeyOptions {
  /** ⌘ на macOS или Ctrl на остальных системах. */
  mod?: boolean;
  /** С `mod`: нужен ли Shift (по умолчанию — нет, ⌘⇧K не вызывает ⌘K). */
  shift?: boolean;
  /** С `mod`: нужен ли Alt. */
  alt?: boolean;
  enabled?: boolean;
}

function isEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  );
}

const LATIN_LETTER = /^[a-z]$/i;

/**
 * Совпадает ли клавиша. Буквенный хоткей на нелатинской раскладке (⌘K на русской даёт «л»)
 * узнаётся по физической клавише `KeyK`; на латинской раскладке — только по букве, иначе
 * в Dvorak ⌘ и клавиша на месте K вызвали бы чужой хоткей.
 */
function matchesKey(event: KeyboardEvent, key: string): boolean {
  if (event.key.toLowerCase() === key.toLowerCase()) return true;
  return LATIN_LETTER.test(key) && !LATIN_LETTER.test(event.key) && event.code === `Key${key.toUpperCase()}`;
}

/**
 * Глобальная горячая клавиша. Без `mod` не срабатывает, пока пользователь печатает в поле.
 * С `mod` модификаторы должны совпасть точно; автоповтор зажатой клавиши и IME пропускаются.
 */
export function useHotkey(
  key: string,
  handler: (event: KeyboardEvent) => void,
  { mod = false, shift = false, alt = false, enabled = true }: HotkeyOptions = {},
): void {
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || isComposing(event) || !matchesKey(event, key)) return;
      if (mod !== (event.metaKey || event.ctrlKey)) return;
      if (mod && (event.shiftKey !== shift || event.altKey !== alt)) return;
      if (!mod && isEditable(event.target)) return;
      event.preventDefault();
      handler(event);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  });
}
