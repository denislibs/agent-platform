import { cloneElement, type ComponentChildren, type Ref, type VNode } from 'preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import { cx } from '../lib/cx.ts';
import { useDismiss } from '../lib/dismiss.ts';
import { FLOATING_STYLE, useFloating, type Placement } from '../lib/floating.ts';
import { tabbables } from '../lib/focus.ts';
import { Portal } from '../lib/portal.tsx';
import { usePresence } from '../lib/presence.ts';
import { mergeRefs } from '../lib/refs.ts';
import { hasModifier } from '../lib/roving.ts';
import { DURATION_MS, TOOLTIP_DELAY_MS } from '../tokens.ts';

export interface PopoverTriggerProps {
  ref: Ref<HTMLButtonElement>;
  'aria-haspopup': 'dialog';
  'aria-expanded': boolean;
  'aria-controls': string | undefined;
  onClick(): void;
}

export interface PopoverProps {
  trigger(props: PopoverTriggerProps): ComponentChildren;
  /** Имя немодального диалога для скринридера. */
  label: string;
  placement?: Placement;
  children: ComponentChildren;
  /** Дополнительные классы панели; склеиваются с базовыми. */
  class?: string;
  className?: string;
}

/**
 * Немодальный поповер: фокус переходит внутрь, Esc и Tab за пределы панели закрывают его и возвращают
 * фокус на кнопку, клик снаружи и фокус, ушедший наружу другим путём, закрывают без возврата фокуса.
 */
export function Popover({
  trigger,
  label,
  placement = 'bottom-start',
  children,
  class: classProp,
  className,
}: PopoverProps) {
  const panelId = `${useId()}-popover`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const { mounted, state } = usePresence(open, DURATION_MS.fast);
  useFloating({ open, anchor: triggerRef, floating: panelRef, placement });
  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };
  useDismiss({ open, onDismiss: reason => close(reason === 'escape'), inside: [triggerRef, panelRef] });
  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  // Панель — портал в конце body: родной Tab увёл бы фокус не к следующему за кнопкой элементу,
  // а в конец документа. Поэтому выход Tab'ом за панель закрывает её и возвращает фокус, как у меню;
  // фокус, ушедший наружу другим путём, закрывает без возврата. Слушатели — на самой панели и только
  // пока поповер открыт.
  useEffect(() => {
    const panel = panelRef.current;
    if (!open || !panel) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || event.defaultPrevented || hasModifier(event)) return;
      const items = tabbables(panel);
      const current = document.activeElement;
      const leaving = event.shiftKey
        ? current === panel || current === items[0]
        : items.length === 0 || current === items.at(-1);
      if (!leaving) return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget;
      // Фокус ушёл «в никуда» (клик по пустому месту) — это решает useDismiss.
      if (!(next instanceof Node)) return;
      if (panel.contains(next) || triggerRef.current?.contains(next)) return;
      // Вложенные слои (меню внутри поповера) рендерятся порталом в body — фокус в них не выход из поповера.
      if (next instanceof Element && next.closest('.ui-floating')) return;
      setOpen(false);
    };
    panel.addEventListener('keydown', onKeyDown);
    panel.addEventListener('focusout', onFocusOut);
    return () => {
      panel.removeEventListener('keydown', onKeyDown);
      panel.removeEventListener('focusout', onFocusOut);
    };
  }, [open]);

  return (
    <>
      {trigger({
        ref: triggerRef,
        'aria-haspopup': 'dialog',
        'aria-expanded': open,
        'aria-controls': mounted ? panelId : undefined,
        onClick: () => (open ? close(true) : setOpen(true)),
      })}
      {mounted && (
        <Portal>
          <div
            ref={panelRef}
            id={panelId}
            role="dialog"
            aria-label={label}
            tabIndex={-1}
            class={cx('ui-floating ui-popover', className, classProp)}
            data-state={state}
            style={FLOATING_STYLE}
          >
            {children}
          </div>
        </Portal>
      )}
    </>
  );
}

export interface TooltipProps {
  content: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
  delay?: number;
  /** Один элемент, который принимает ref (Button, IconButton или DOM-элемент). */
  children: VNode;
  /** Дополнительные классы тултипа; склеиваются с базовыми. */
  class?: string;
  className?: string;
}

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Упрощённое доступное имя: aria-labelledby, иначе aria-label, иначе текст элемента. */
function accessibleName(el: HTMLElement | null): string {
  if (!el) return '';
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy)
    return normalize(
      labelledBy
        .split(/\s+/)
        .map(id => document.getElementById(id)?.textContent ?? '')
        .join(' '),
    );
  return normalize(el.getAttribute('aria-label') ?? el.textContent ?? '');
}

type Handler = ((event: Event) => void) | undefined;

/**
 * Тултип по наведению и фокусу с задержкой 400 мс; Esc скрывает его, не трогая фокус (WCAG 1.4.13).
 * Дублирует подпись, но не заменяет её: у иконочной кнопки всё равно должен быть aria-label.
 */
export function Tooltip({
  content,
  side = 'top',
  delay = TOOLTIP_DELAY_MS,
  children,
  class: classProp,
  className,
}: TooltipProps) {
  const id = `${useId()}-tooltip`;
  const anchor = useRef<HTMLElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  // wanted — указатель или фокус на элементе; open — тултип показан (после задержки).
  const [wanted, setWanted] = useState(false);
  const [open, setOpen] = useState(false);
  // Текст тултипа совпадает с именем якоря — описывать им якорь незачем (скринридер прочтёт дважды).
  const [repeatsName, setRepeatsName] = useState(false);
  useFloating({ open, anchor, floating: tip, placement: side, gap: 8 });
  useEffect(() => {
    if (!wanted) return setOpen(false);
    const timer = setTimeout(() => {
      // Имя берётся из DOM в момент показа: у IconButton оно приходит из `label`, а не из aria-label в пропсах.
      setRepeatsName(accessibleName(anchor.current) === normalize(content));
      setOpen(true);
    }, delay);
    return () => clearTimeout(timer);
  }, [wanted, delay, content]);
  useEffect(() => {
    if (!open) return;
    // На погружении и с preventDefault: Esc скрывает только тултип, а слой под ним (диалог,
    // поповер) не закрывается — useDismiss пропускает уже обработанное событие.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return;
      event.preventDefault();
      setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open]);

  const own = children.props as Record<string, unknown>;
  const chain = (name: string, next: boolean) => (event: Event) => {
    (own[name] as Handler)?.(event);
    setWanted(next);
  };
  const describedBy = [own['aria-describedby'], open && !repeatsName && id].filter(Boolean).join(' ');

  return (
    <>
      {cloneElement(children, {
        ref: mergeRefs(anchor, (children as VNode & { ref?: Ref<HTMLElement> }).ref),
        'aria-describedby': describedBy || undefined,
        onPointerEnter: chain('onPointerEnter', true),
        onPointerLeave: chain('onPointerLeave', false),
        onFocus: chain('onFocus', true),
        onBlur: chain('onBlur', false),
      })}
      {open && (
        <Portal>
          <div
            ref={tip}
            id={id}
            role="tooltip"
            class={cx('ui-tooltip', className, classProp)}
            data-side={side}
            style={FLOATING_STYLE}
          >
            {content}
          </div>
        </Portal>
      )}
    </>
  );
}
