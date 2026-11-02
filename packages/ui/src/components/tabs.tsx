import type { ComponentChildren } from 'preact';
import { useId, useRef } from 'preact/hooks';
import { cx } from '../lib/cx.ts';
import { nextIndex } from '../lib/roving.ts';

export interface TabItem<V extends string> {
  value: V;
  label: ComponentChildren;
  /** Счётчик-бейдж после подписи. */
  count?: number;
  disabled?: boolean;
  /** Содержимое вкладки. Без панелей Tabs работает как фильтр (вкладки-пилюли). */
  panel?: ComponentChildren;
}

export interface TabsProps<V extends string> {
  label: string;
  /** Тип значений выводится из списка вариантов. */
  value: NoInfer<V>;
  onChange(value: NoInfer<V>): void;
  items: ReadonlyArray<TabItem<V>>;
  variant?: 'underline' | 'pills';
}

/** WAI-ARIA Tabs: roving tabindex, стрелки по кругу, Home/End; выбор следует за фокусом. */
export function Tabs<V extends string>({ label, value, onChange, items, variant = 'underline' }: TabsProps<V>) {
  const base = useId();
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const hasPanels = items.some(item => item.panel !== undefined);
  const selected = items.findIndex(item => item.value === value);
  const focusable = selected >= 0 ? selected : items.findIndex(item => !item.disabled);
  const tabId = (index: number) => `${base}-tab-${index}`;
  const panelId = (index: number) => `${base}-panel-${index}`;

  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const next = nextIndex(event.key, index, items.length, i => Boolean(items[i]!.disabled), 'horizontal');
    if (next === null) return;
    event.preventDefault();
    tabs.current[next]?.focus();
    onChange(items[next]!.value);
  };

  return (
    <>
      <div class={cx('ui-tabs', variant === 'pills' && 'ui-tabs--pills')} role="tablist" aria-label={label}>
        {items.map((item, index) => (
          <button
            key={item.value}
            ref={el => {
              tabs.current[index] = el;
            }}
            type="button"
            role="tab"
            id={tabId(index)}
            class="ui-tab"
            aria-selected={index === selected}
            aria-controls={hasPanels ? panelId(index) : undefined}
            tabIndex={index === focusable ? 0 : -1}
            disabled={item.disabled}
            onClick={() => onChange(item.value)}
            onKeyDown={event => onKeyDown(event, index)}
          >
            {item.label}
            {item.count !== undefined && <span class="ui-badge ui-badge--count">{item.count}</span>}
          </button>
        ))}
      </div>
      {hasPanels &&
        items.map(
          (item, index) =>
            index === selected && (
              <div key={item.value} role="tabpanel" id={panelId(index)} aria-labelledby={tabId(index)} tabIndex={0}>
                {item.panel}
              </div>
            ),
        )}
    </>
  );
}
