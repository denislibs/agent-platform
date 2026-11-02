import type { RefObject } from 'preact';
import { useEffect, useState } from 'preact/hooks';

const TABBABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]',
  '[contenteditable="true"]',
].join(',');

/** Элементы, до которых доходит Tab, в порядке документа. */
export function tabbables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    el => el.tabIndex >= 0 && !el.closest('[inert], [hidden], [aria-hidden="true"]'),
  );
}

// Активные ловушки по порядку включения: Tab обрабатывает только верхняя (диалог поверх диалога).
const traps: object[] = [];

/**
 * Пока `active`: фокус внутри контейнера — на `[data-autofocus]`, иначе на первом фокусируемом,
 * иначе на самом контейнере; Tab и Shift+Tab ходят по кругу. При выключении фокус возвращается
 * на элемент, который был в фокусе до включения.
 */
export function useFocusTrap(container: RefObject<HTMLElement>, active: boolean): void {
  const [token] = useState(() => ({}));
  useEffect(() => {
    const root = container.current;
    if (!active || !root) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    traps.push(token);
    (root.querySelector<HTMLElement>('[data-autofocus]') ?? tabbables(root)[0] ?? root).focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || traps.at(-1) !== token) return;
      const items = tabbables(root);
      const current = document.activeElement;
      const first = items[0];
      const last = items.at(-1);
      if (!first || !last) {
        event.preventDefault();
        root.focus();
      } else if (event.shiftKey && (current === first || !root.contains(current))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (current === last || !root.contains(current))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      traps.splice(traps.indexOf(token), 1);
      document.removeEventListener('keydown', onKeyDown);
      previous?.focus();
    };
  }, [active, container, token]);
}

let locks = 0;
let saved = { overflow: '', paddingRight: '' };

/**
 * Блокирует прокрутку страницы под модальным слоем; вложенные блокировки считаются, последняя
 * снятая возвращает исходные overflow и padding-right. Пока прокрутка заблокирована, ширина
 * исчезнувшей полосы прокрутки добавляется к padding-right, чтобы страница не сдвигалась вбок.
 */
export function useScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const { style } = document.body;
    if (locks++ === 0) {
      saved = { overflow: style.overflow, paddingRight: style.paddingRight };
      const viewport = document.documentElement.clientWidth;
      // clientWidth = 0 — раскладки нет (happy-dom, скрытый iframe): компенсировать нечего.
      const gap = viewport > 0 ? window.innerWidth - viewport : 0;
      if (gap > 0) {
        const padding = Number.parseFloat(getComputedStyle(document.body).paddingRight) || 0;
        style.paddingRight = `${padding + gap}px`;
      }
      style.overflow = 'hidden';
    }
    return () => {
      if (--locks > 0) return;
      style.overflow = saved.overflow;
      style.paddingRight = saved.paddingRight;
    };
  }, [active]);
}
