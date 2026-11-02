import type { ComponentChildren } from 'preact';
import { useEffect, useId, useMemo, useState } from 'preact/hooks';
import { Search, type LucideIcon } from 'lucide-preact';
import { useDismiss } from '../lib/dismiss.ts';
import { useFocusTrap, useScrollLock } from '../lib/focus.ts';
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
  const optionId = (id: string) => `${base}-option-${id}`;
  const [panel, setPanel] = useState<HTMLDivElement | null>(null);
  const panelRef = useMemo(() => ({ current: panel }), [panel]);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const { mounted, state } = usePresence(open, DURATION_MS.base);
  useFocusTrap(panelRef, open);
  useScrollLock(open);
  useDismiss({ open, onDismiss: () => onOpenChange(false), inside: [panelRef] });
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
  }, [open]);

  const visible = filterCommands(groups, query);
  const flat = visible.flatMap(group => group.items);
  const current = flat[Math.min(active, flat.length - 1)];
  const run = (item: CommandItem | undefined) => {
    if (!item) return;
    onOpenChange(false);
    item.onSelect();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    // Enter подтверждает набор через IME, а стрелки с модификаторами принадлежат браузеру и ОС.
    if (event.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      run(current);
      return;
    }
    if ((event.key !== 'ArrowDown' && event.key !== 'ArrowUp') || hasModifier(event)) return;
    const next = nextIndex(event.key, flat.indexOf(current!), flat.length, () => false, 'vertical');
    if (next === null) return;
    event.preventDefault();
    setActive(next);
    document.getElementById(optionId(flat[next]!.id))?.scrollIntoView?.({ block: 'nearest' });
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
              aria-activedescendant={current ? optionId(current.id) : undefined}
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
              if (option) run(flat.find(item => optionId(item.id) === option.id));
            }}
          >
            {flat.length === 0 && <div class="ui-command__empty">{emptyText}</div>}
            {/* id группы — по номеру: подпись с пробелом сломала бы aria-labelledby (список id). */}
            {visible.map((group, index) => (
              <div key={group.label} role="group" aria-labelledby={`${base}-group-${index}`}>
                <div id={`${base}-group-${index}`} class="ui-menu__label" role="presentation">
                  {group.label}
                </div>
                {group.items.map(item => {
                  const Icon = item.icon;
                  return (
                    <div
                      key={item.id}
                      id={optionId(item.id)}
                      role="option"
                      aria-selected={item === current}
                      class="ui-menu__item"
                      data-highlighted={item === current ? '' : undefined}
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
