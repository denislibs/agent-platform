import type { RefObject } from 'preact';
import { useEffect } from 'preact/hooks';

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

interface Trap {
  root: HTMLElement;
  /** Слой, куда порталом рендерятся вложенные поповеры и меню; фокус в нём — не выход из ловушки. */
  layer: HTMLElement | null;
  /** Куда вернуть фокус при выключении. */
  previous: HTMLElement | null;
}

// Активные ловушки по порядку включения: Tab обрабатывает только верхняя (диалог поверх диалога).
const traps: Trap[] = [];

const holds = (trap: Trap, node: unknown): boolean =>
  node instanceof Node && (trap.root.contains(node) || Boolean(trap.layer?.contains(node)));

/**
 * Пока `active`: фокус внутри контейнера — на `[data-autofocus]`, иначе на первом фокусируемом,
 * иначе на самом контейнере; Tab и Shift+Tab ходят по кругу. При выключении фокус возвращается
 * на элемент, который был в фокусе до включения, — если ловушка верхняя или фокус ещё в ней:
 * закрытие нижнего слоя не отнимает фокус у верхнего.
 *
 * `layer` — контейнер вложенных слоёв (PortalContext диалога): поповер с полями внутри диалога
 * рендерится рядом с панелью, и Tab по его полям не должен перескакивать на первое поле диалога.
 */
export function useFocusTrap(container: RefObject<HTMLElement>, active: boolean, layer?: RefObject<HTMLElement>): void {
  useEffect(() => {
    const root = container.current;
    if (!active || !root) return;
    const trap: Trap = {
      root,
      layer: layer?.current ?? null,
      previous: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    };
    traps.push(trap);
    (root.querySelector<HTMLElement>('[data-autofocus]') ?? tabbables(root)[0] ?? root).focus();
    // Фокус на самой панели (tabIndex −1, например после клика по тексту) — Shift+Tab ведёт на последний.
    const onKeyDown = (event: KeyboardEvent) => {
      // defaultPrevented — Tab уже обработал вложенный слой (поповер закрылся и вернул фокус на кнопку).
      if (event.key !== 'Tab' || event.defaultPrevented || traps.at(-1) !== trap) return;
      const items = tabbables(root);
      const current = document.activeElement;
      const first = items[0];
      const last = items.at(-1);
      if (!first || !last) {
        event.preventDefault();
        root.focus();
      } else if (event.shiftKey && (current === first || current === root || !holds(trap, current))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (current === last || !holds(trap, current))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      const index = traps.indexOf(trap);
      const top = index === traps.length - 1;
      traps.splice(index, 1);
      document.removeEventListener('keydown', onKeyDown);
      if (top || holds(trap, document.activeElement)) {
        trap.previous?.focus();
        return;
      }
      // Ловушки выше, запомнившие фокус внутри этой, вернут его туда же, куда вернула бы она:
      // элемент закрытого слоя скоро исчезнет из документа.
      for (const upper of traps.slice(index)) if (holds(trap, upper.previous)) upper.previous = trap.previous;
    };
  }, [active, container, layer]);
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
