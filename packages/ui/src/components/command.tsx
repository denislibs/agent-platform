import type { ComponentChildren } from 'preact';
import { useId, useMemo, useState } from 'preact/hooks';
import { Search, type LucideIcon } from 'lucide-preact';
import { useDismiss } from '../lib/dismiss.ts';
import { useFocusTrap, useScrollLock } from '../lib/focus.ts';
import { isComposing } from '../lib/ime.ts';
import { Portal } from '../lib/portal.tsx';
import { usePresence } from '../lib/presence.ts';
import { hasModifier, nextIndex } from '../lib/roving.ts';
import { DURATION_MS } from '../tokens.ts';
import { Kbd, KbdCombo } from './display.tsx';

export interface CommandItem {
  id: string;
  label: string;
  icon?: LucideIcon;
  shortcut?: readonly string[];
  trail?: ComponentChildren;
  /** Дополнительные слова для поиска. */
  keywords?: string;
  onSelect(): void;
}

export interface CommandGroup {
  label: string;
  items: readonly CommandItem[];
}

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  groups: readonly CommandGroup[];
  label?: string;
  placeholder?: string;
  emptyText?: string;
}

export function filterCommands(groups: readonly CommandGroup[], query: string): CommandGroup[] {
  const q = query.trim().toLowerCase();
  return groups
    .map(group => ({
      ...group,
      items: group.items.filter(item => `${item.label} ${item.keywords ?? ''}`.toLowerCase().includes(q)),
    }))
    .filter(group => group.items.length > 0);
}

/**
 * Палитра команд (⌘K открывает приложение через useHotkey): поле — combobox, список — listbox
 * с aria-activedescendant; ввод фильтрует, ↑/↓ двигают, Enter выполняет, Esc закрывает.
 */
export function CommandPalette({
  open,
  onOpenChange,
  groups,
  label = 'Command palette',
  placeholder = 'Search tasks, files and commands…',
  emptyText = 'No results',
}: CommandPaletteProps) {
  const base = useId();
  const listId = `${base}-list`;
  // id опции — по месту в отфильтрованном списке: id команд могут повторяться и содержать пробелы.
  const optionId = (index: number) => `${base}-option-${index}`;
  const [panel, setPanel] = useState<HTMLDivElement | null>(null);
  const panelRef = useMemo(() => ({ current: panel }), [panel]);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const { mounted, state } = usePresence(open, DURATION_MS.base);
  useFocusTrap(panelRef, open);
  useScrollLock(open);
  useDismiss({ open, onDismiss: () => onOpenChange(false), inside: [panelRef] });
  // Сброс при открытии — во время рендера, а не эффектом: уже первый кадр открытой палитры
  // показывает пустой запрос, а не фильтр прошлого открытия.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setQuery('');
      setActive(0);
    }
  }

  const visible = filterCommands(groups, query);
  const flat = visible.flatMap(group => group.items);
  // Номер первой опции каждой группы в общем списке.
  const starts: number[] = [];
  let count = 0;
  for (const group of visible) {
    starts.push(count);
    count += group.items.length;
  }
  const activeIndex = Math.min(active, flat.length - 1);
  const run = (index: number) => {
    const item = flat[index];
    if (!item) return;
    onOpenChange(false);
    item.onSelect();
  };
  const found = flat.length === 1 ? '1 result' : `${flat.length} results`;
  // Живой регион: пустой запрос не объявляется, иначе — число результатов или «No results».
  const status = flat.length === 0 ? emptyText : query.trim() ? found : '';
  const onKeyDown = (event: KeyboardEvent) => {
    // Enter подтверждает набор через IME, а стрелки с модификаторами принадлежат браузеру и ОС.
    if (isComposing(event)) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      run(activeIndex);
      return;
    }
    if ((event.key !== 'ArrowDown' && event.key !== 'ArrowUp') || hasModifier(event)) return;
    const next = nextIndex(event.key, activeIndex, flat.length, () => false, 'vertical');
    if (next === null) return;
    event.preventDefault();
    setActive(next);
    document.getElementById(optionId(next))?.scrollIntoView?.({ block: 'nearest' });
  };

  if (!mounted) return null;
  return (
    <Portal>
      <div class="ui-overlay" data-state={state}>
        <div ref={setPanel} class="ui-command" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>
          <div class="ui-command__input">
            <Search aria-hidden="true" />
            <input
              data-autofocus
              role="combobox"
              aria-label={label}
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
              placeholder={placeholder}
              value={query}
              onInput={event => {
                setQuery(event.currentTarget.value);
                setActive(0);
              }}
              onKeyDown={onKeyDown}
            />
            <Kbd>esc</Kbd>
          </div>
          <div
            id={listId}
            role="listbox"
            aria-label={label}
            tabIndex={-1}
            class="ui-command__list"
            onPointerDown={event => event.preventDefault()}
            onKeyDown={onKeyDown}
            onClick={event => {
              const option = (event.target as Element).closest<HTMLElement>('[role="option"]');
              if (option) run(flat.findIndex((_, index) => optionId(index) === option.id));
            }}
          >
            {/* id группы — по номеру: подпись с пробелом сломала бы aria-labelledby (список id). */}
            {visible.map((group, index) => (
              <div key={group.label} role="group" aria-labelledby={`${base}-group-${index}`}>
                <div id={`${base}-group-${index}`} class="ui-menu__label" role="presentation">
                  {group.label}
                </div>
                {group.items.map((item, offset) => {
                  const Icon = item.icon;
                  const position = starts[index]! + offset;
                  return (
                    <div
                      key={position}
                      id={optionId(position)}
                      role="option"
                      aria-selected={position === activeIndex}
                      class="ui-menu__item"
                      data-highlighted={position === activeIndex ? '' : undefined}
                    >
                      {Icon && <Icon aria-hidden="true" />}
                      {item.label}
                      {(item.shortcut || item.trail) && (
                        <span class="ui-menu__trail">
                          {item.shortcut ? <KbdCombo keys={item.shortcut} /> : item.trail}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          {/* Вне listbox: там допустимы только опции. Без результатов регион виден как пустое состояние. */}
          <div role="status" class={flat.length === 0 ? 'ui-command__empty' : 'ui-sr-only'}>
            {status}
          </div>
          <div class="ui-command__footer">
            <span>
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd>
              navigate
            </span>
            <span>
              <Kbd>↵</Kbd>
              open
            </span>
          </div>
        </div>
      </div>
    </Portal>
  );
}
