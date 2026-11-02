import { cloneElement, type ComponentChildren, type Ref, type VNode } from 'preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import { useDismiss } from '../lib/dismiss.ts';
import { FLOATING_STYLE, useFloating, type Placement } from '../lib/floating.ts';
import { Portal } from '../lib/portal.tsx';
import { usePresence } from '../lib/presence.ts';
import { mergeRefs } from '../lib/refs.ts';
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
}

/** Немодальный поповер: фокус переходит внутрь, Esc возвращает его на кнопку, клик снаружи закрывает. */
export function Popover({ trigger, label, placement = 'bottom-start', children }: PopoverProps) {
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
            class="ui-floating ui-popover"
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
}

type Handler = ((event: Event) => void) | undefined;

/**
 * Тултип по наведению и фокусу с задержкой 400 мс; Esc скрывает его, не трогая фокус (WCAG 1.4.13).
 * Дублирует подпись, но не заменяет её: у иконочной кнопки всё равно должен быть aria-label.
 */
export function Tooltip({ content, side = 'top', delay = TOOLTIP_DELAY_MS, children }: TooltipProps) {
  const id = `${useId()}-tooltip`;
  const anchor = useRef<HTMLElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  // wanted — указатель или фокус на элементе; open — тултип показан (после задержки).
  const [wanted, setWanted] = useState(false);
  const [open, setOpen] = useState(false);
  useFloating({ open, anchor, floating: tip, placement: side, gap: 8 });
  useEffect(() => {
    if (!wanted) return setOpen(false);
    const timer = setTimeout(() => setOpen(true), delay);
    return () => clearTimeout(timer);
  }, [wanted, delay]);
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const own = children.props as Record<string, unknown>;
  const chain = (name: string, next: boolean) => (event: Event) => {
    (own[name] as Handler)?.(event);
    setWanted(next);
  };
  const describedBy = [own['aria-describedby'], open && content !== own['aria-label'] && id].filter(Boolean).join(' ');

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
          <div ref={tip} id={id} role="tooltip" class="ui-tooltip" data-side={side} style={FLOATING_STYLE}>
            {content}
          </div>
        </Portal>
      )}
    </>
  );
}
