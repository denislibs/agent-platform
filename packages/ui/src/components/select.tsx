import type { ComponentChildren } from 'preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import { Check, ChevronDown, type LucideIcon } from 'lucide-preact';
import { cx } from '../lib/cx.ts';
import { useDismiss } from '../lib/dismiss.ts';
import { FLOATING_STYLE, useFloating } from '../lib/floating.ts';
import { Portal } from '../lib/portal.tsx';
import { usePresence } from '../lib/presence.ts';
import { hasModifier, nextIndex } from '../lib/roving.ts';
import { DURATION_MS } from '../tokens.ts';
import { useFieldControl } from './field.tsx';

export interface SelectItem<V extends string> {
  value: V;
  label: string;
  /** Пояснение справа, например «Best plans». */
  description?: ComponentChildren;
  disabled?: boolean;
}

export interface SelectProps<V extends string> {
  /** Тип значений выводится из options; `undefined` — ничего не выбрано (показывается placeholder). */
  value: NoInfer<V> | undefined;
  onChange(value: NoInfer<V>): void;
  options: ReadonlyArray<SelectItem<V>>;
  placeholder?: string;
  /** Имя для скринридера, если select не внутри `<Field>`. */
  label?: string;
  icon?: LucideIcon;
  size?: 'sm' | 'md';
  disabled?: boolean;
  /** Дополнительные классы кнопки-комбобокса; склеиваются с базовыми. */
  class?: string;
  className?: string;
}

/**
 * Кастомный select по шаблону WAI-ARIA «select-only combobox»: фокус всегда на кнопке,
 * активная опция — через aria-activedescendant. ↓/↑/Enter/Space открывают, стрелки и Home/End
 * двигают, Enter/Space выбирают, Esc и клик снаружи закрывают без выбора.
 */
export function Select<V extends string>({
  value,
  onChange,
  options,
  placeholder = 'Select…',
  label,
  icon: Icon,
  size = 'md',
  disabled,
  class: classProp,
  className,
}: SelectProps<V>) {
  const base = useId();
  const listId = `${base}-listbox`;
  const optionId = (index: number) => `${base}-option-${index}`;
  const field = useFieldControl({});
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const { mounted, state } = usePresence(open, DURATION_MS.fast);
  useFloating({ open, anchor: triggerRef, floating: listRef, matchWidth: true });
  useDismiss({
    open,
    // Esc возвращает фокус на кнопку (он мог уйти с неё), клик снаружи оставляет его там, куда кликнули.
    onDismiss: reason => {
      setOpen(false);
      if (reason === 'escape') triggerRef.current?.focus();
    },
    inside: [triggerRef, listRef],
  });

  const selectedIndex = options.findIndex(option => option.value === value);
  const isDisabled = (index: number) => Boolean(options[index]!.disabled);
  useEffect(() => {
    if (open && active >= 0)
      document.getElementById(`${base}-option-${active}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active, base]);

  const openList = () => {
    setActive(
      selectedIndex >= 0 ? selectedIndex : (nextIndex('Home', 0, options.length, isDisabled, 'vertical') ?? -1),
    );
    setOpen(true);
    // Фокус всегда на кнопке, а клик в Safari и Firefox её не фокусирует — иначе стрелки не дошли бы.
    triggerRef.current?.focus();
  };
  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    setOpen(false);
    triggerRef.current?.focus();
    if (option.value !== value) onChange(option.value);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (hasModifier(event) || (event.key === 'Enter' && event.isComposing)) return;
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
        event.preventDefault();
        openList();
      }
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      choose(active);
    } else if (event.key === 'Tab') {
      setOpen(false);
    } else {
      const next = nextIndex(event.key, active, options.length, isDisabled, 'vertical');
      if (next === null) return;
      event.preventDefault();
      setActive(next);
    }
  };

  const selected = options[selectedIndex];
  return (
    <>
      <button
        {...field}
        ref={triggerRef}
        type="button"
        role="combobox"
        class={cx('ui-input', size === 'sm' && 'ui-input--sm', 'ui-select-trigger', className, classProp)}
        data-placeholder={selected ? undefined : ''}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onKeyDown}
      >
        {Icon && <Icon aria-hidden="true" class="ui-text-tertiary" />}
        <span>{selected?.label ?? placeholder}</span>
        <ChevronDown aria-hidden="true" />
      </button>
      {mounted && (
        <Portal>
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-labelledby={field.id}
            aria-label={field.id ? undefined : label}
            tabIndex={-1}
            class="ui-floating ui-menu"
            data-state={state}
            style={FLOATING_STYLE}
            // Фокус остаётся на кнопке; клик по опции ловится на списке (опции не фокусируются).
            onPointerDown={event => event.preventDefault()}
            onKeyDown={onKeyDown}
            onClick={event => {
              const option = (event.target as Element).closest<HTMLElement>('[role="option"]');
              if (option) choose(Number(option.dataset.index));
            }}
          >
            {options.map((option, index) => (
              <div
                key={option.value}
                id={optionId(index)}
                role="option"
                aria-selected={index === selectedIndex}
                aria-disabled={option.disabled || undefined}
                class="ui-menu__item"
                data-index={index}
                data-highlighted={index === active ? '' : undefined}
              >
                <span class="ui-menu__check">
                  <Check aria-hidden="true" />
                </span>
                {option.label}
                {option.description && <span class="ui-menu__trail">{option.description}</span>}
              </div>
            ))}
          </div>
        </Portal>
      )}
    </>
  );
}
