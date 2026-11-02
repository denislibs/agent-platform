import type { ComponentChildren, Ref } from 'preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import { Check, type LucideIcon } from 'lucide-preact';
import { cx } from '../lib/cx.ts';
import { useDismiss } from '../lib/dismiss.ts';
import { FLOATING_STYLE, useFloating, type Placement } from '../lib/floating.ts';
import { Portal } from '../lib/portal.tsx';
import { usePresence } from '../lib/presence.ts';
import { hasModifier, nextIndex } from '../lib/roving.ts';
import { DURATION_MS } from '../tokens.ts';
import { KbdCombo } from './display.tsx';

export type MenuEntry =
  | {
      kind: 'item';
      id: string;
      label: string;
      icon?: LucideIcon;
      /** Клавиши справа, например `['⌘', '⌫']`. */
      shortcut?: readonly string[];
      /** Другое содержимое справа (бейдж, стрелка подменю). */
      trail?: ComponentChildren;
      danger?: boolean;
      disabled?: boolean;
      onSelect(): void;
    }
  | {
      kind: 'checkbox';
      id: string;
      label: string;
      icon?: LucideIcon;
      checked: boolean;
      disabled?: boolean;
      onCheckedChange(checked: boolean): void;
    }
  | { kind: 'label'; id: string; label: string }
  | { kind: 'separator'; id: string };

export interface MenuTriggerProps {
  ref: Ref<HTMLButtonElement>;
  id: string;
  'aria-haspopup': 'menu';
  'aria-expanded': boolean;
  'aria-controls': string | undefined;
  onClick(): void;
  onKeyDown(event: KeyboardEvent): void;
}

export interface MenuProps {
  /** Кнопка-триггер: пропсы нужно передать кнопке целиком (`<Button {...props}>`). */
  trigger(props: MenuTriggerProps): ComponentChildren;
  items: readonly MenuEntry[];
  placement?: Placement;
  width?: number;
}

const ITEM_SELECTOR = '[role="menuitem"], [role="menuitemcheckbox"]';
const isDisabled = (el: Element) => el.getAttribute('aria-disabled') === 'true';

/**
 * WAI-ARIA Menu Button: Enter, Space и ↓ открывают меню с фокусом на первом пункте, ↑ — на последнем;
 * стрелки по кругу, Home/End; Esc и выбор возвращают фокус на кнопку; Tab закрывает меню.
 */
export function Menu({ trigger, items, placement = 'bottom-start', width }: MenuProps) {
  const base = useId();
  const triggerId = `${base}-trigger`;
  const menuId = `${base}-menu`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [focusLast, setFocusLast] = useState(false);
  const { mounted, state } = usePresence(open, DURATION_MS.fast);
  useFloating({ open, anchor: triggerRef, floating: menuRef, placement });

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };
  useDismiss({ open, onDismiss: reason => close(reason === 'escape'), inside: [triggerRef, menuRef] });

  const menuItems = () => [...(menuRef.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? [])];
  useEffect(() => {
    if (!open) return;
    const enabled = menuItems().filter(el => !isDisabled(el));
    (focusLast ? enabled.at(-1) : enabled[0])?.focus();
  }, [open, focusLast]);

  const openMenu = (last: boolean) => {
    setFocusLast(last);
    setOpen(true);
  };

  const onMenuKeyDown = (event: KeyboardEvent) => {
    if (hasModifier(event)) return;
    if (event.key === 'Tab') {
      event.preventDefault();
      close(true);
      return;
    }
    const all = menuItems();
    const next = nextIndex(
      event.key,
      all.indexOf(document.activeElement as HTMLElement),
      all.length,
      i => isDisabled(all[i]!),
      'vertical',
    );
    if (next === null) return;
    event.preventDefault();
    all[next]!.focus();
  };

  const choose = (entry: Extract<MenuEntry, { kind: 'item' | 'checkbox' }>) => {
    if (entry.disabled) return;
    if (entry.kind === 'checkbox') return entry.onCheckedChange(!entry.checked);
    close(true);
    entry.onSelect();
  };

  return (
    <>
      {trigger({
        ref: triggerRef,
        id: triggerId,
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        'aria-controls': mounted ? menuId : undefined,
        // Закрытие повторным кликом тоже возвращает фокус: в Safari и Firefox клик не фокусирует кнопку,
        // и фокус пропал бы вместе с пунктом меню.
        onClick: () => (open ? close(true) : openMenu(false)),
        onKeyDown: event => {
          if (open || hasModifier(event)) return;
          if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openMenu(false);
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            openMenu(true);
          }
        },
      })}
      {mounted && (
        <Portal>
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-labelledby={triggerId}
            tabIndex={-1}
            class="ui-floating ui-menu"
            data-state={state}
            style={{ ...FLOATING_STYLE, width }}
            onKeyDown={onMenuKeyDown}
          >
            {items.map(entry => {
              if (entry.kind === 'label')
                return (
                  <div key={entry.id} class="ui-menu__label" role="presentation">
                    {entry.label}
                  </div>
                );
              if (entry.kind === 'separator') return <div key={entry.id} class="ui-menu__sep" role="none" />;
              const Icon = entry.icon;
              return (
                <button
                  key={entry.id}
                  type="button"
                  role={entry.kind === 'checkbox' ? 'menuitemcheckbox' : 'menuitem'}
                  aria-checked={entry.kind === 'checkbox' ? entry.checked : undefined}
                  aria-disabled={entry.disabled || undefined}
                  tabIndex={-1}
                  class={cx('ui-menu__item', entry.kind === 'item' && entry.danger && 'ui-menu__item--danger')}
                  onClick={() => choose(entry)}
                >
                  {Icon && <Icon aria-hidden="true" />}
                  {entry.label}
                  {entry.kind === 'checkbox' ? (
                    <span class="ui-menu__trail ui-menu__check">
                      <Check aria-hidden="true" />
                    </span>
                  ) : (
                    (entry.shortcut || entry.trail) && (
                      <span class="ui-menu__trail">
                        {entry.shortcut ? <KbdCombo keys={entry.shortcut} /> : entry.trail}
                      </span>
                    )
                  )}
                </button>
              );
            })}
          </div>
        </Portal>
      )}
    </>
  );
}
