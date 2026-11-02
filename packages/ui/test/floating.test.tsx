import { expect, mock, test } from 'bun:test';
import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { useState } from 'preact/hooks';
import { Copy, Pencil, Trash2 } from 'lucide-preact';
import { Button, IconButton, Menu, Popover, Select, Tooltip, type MenuEntry } from '../src/index.ts';
import { gone } from './helpers.ts';

function TaskMenu({ onRename, onDelete }: { onRename(): void; onDelete(): void }) {
  const [pinned, setPinned] = useState(false);
  const items: MenuEntry[] = [
    { kind: 'label', id: 'l', label: 'Task' },
    { kind: 'item', id: 'rename', label: 'Rename', icon: Pencil, shortcut: ['R'], onSelect: onRename },
    { kind: 'checkbox', id: 'pin', label: 'Pinned', checked: pinned, onCheckedChange: setPinned },
    { kind: 'item', id: 'share', label: 'Share', disabled: true, onSelect: () => {} },
    { kind: 'separator', id: 's' },
    { kind: 'item', id: 'delete', label: 'Delete', icon: Trash2, danger: true, onSelect: onDelete },
  ];
  return (
    <>
      <Menu items={items} trigger={props => <Button {...props}>Task actions</Button>} />
      <button type="button">Elsewhere</button>
    </>
  );
}

test('Menu opens from the keyboard on the first item and wraps with the arrows, skipping disabled items', async () => {
  const user = userEvent.setup();
  render(<TaskMenu onRename={() => {}} onDelete={() => {}} />);
  const trigger = screen.getByRole('button', { name: 'Task actions' });
  expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
  trigger.focus();
  await user.keyboard('{Enter}');
  const menu = screen.getByRole('menu', { name: 'Task actions' });
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  expect(trigger.getAttribute('aria-controls')).toBe(menu.id);
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Rename R' }));
  await user.keyboard('{ArrowDown}{ArrowDown}');
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Delete' }));
  await user.keyboard('{ArrowDown}');
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Rename R' }));
  await user.keyboard('{End}');
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Delete' }));
});

test('Menu closes on Escape and returns focus; ArrowUp opens on the last item', async () => {
  const user = userEvent.setup();
  render(<TaskMenu onRename={() => {}} onDelete={() => {}} />);
  const trigger = screen.getByRole('button', { name: 'Task actions' });
  trigger.focus();
  await user.keyboard('{ArrowUp}');
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Delete' }));
  await user.keyboard('{Escape}');
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(trigger);
  await gone(() => screen.queryByRole('menu'));
});

test('choosing an item runs it and closes the menu; a checkbox item toggles in place', async () => {
  const user = userEvent.setup();
  const onRename = mock(() => {});
  render(<TaskMenu onRename={onRename} onDelete={() => {}} />);
  await user.click(screen.getByRole('button', { name: 'Task actions' }));
  const pin = screen.getByRole('menuitemcheckbox', { name: 'Pinned' });
  await user.click(pin);
  expect(pin.getAttribute('aria-checked')).toBe('true');
  expect(screen.getByRole('button', { name: 'Task actions' }).getAttribute('aria-expanded')).toBe('true');
  await user.click(screen.getByRole('menuitem', { name: 'Rename R' }));
  expect(onRename).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Task actions' }));
});

test('a click outside closes the menu; the floating layer is positioned by Floating UI', async () => {
  const user = userEvent.setup();
  render(<TaskMenu onRename={() => {}} onDelete={() => {}} />);
  await user.click(screen.getByRole('button', { name: 'Task actions' }));
  const menu = screen.getByRole('menu');
  await waitFor(() => expect(menu.dataset.placement).toBe('bottom-start'));
  expect(menu.style.position).toBe('fixed');
  await waitFor(() => expect(menu.dataset.state).toBe('open'));
  await user.click(screen.getByRole('button', { name: 'Elsewhere' }));
  expect(menu.dataset.state).toBe('closed');
  await gone(() => screen.queryByRole('menu'));
});

type Model = 'planner' | 'vision' | 'executor';

function ModelSelect({ onChange }: { onChange(value: Model): void }) {
  const [model, setModel] = useState<Model | undefined>('planner');
  return (
    <Select
      label="Default model"
      value={model}
      onChange={value => {
        setModel(value);
        onChange(value);
      }}
      options={[
        { value: 'planner', label: 'Planner · DeepSeek', description: 'Best plans' },
        { value: 'vision', label: 'Vision model', disabled: true },
        { value: 'executor', label: 'Executor · Qwen', description: 'Fast' },
      ]}
    />
  );
}

test('Select keeps focus on the combobox and moves the active option with the keyboard', async () => {
  const user = userEvent.setup();
  const onChange = mock((_value: string) => {});
  render(<ModelSelect onChange={onChange} />);
  const combobox = screen.getByRole('combobox', { name: 'Default model' });
  expect(combobox.textContent).toBe('Planner · DeepSeek');
  combobox.focus();
  await user.keyboard('{ArrowDown}');
  const listbox = screen.getByRole('listbox', { name: 'Default model' });
  expect(combobox.getAttribute('aria-controls')).toBe(listbox.id);
  const planner = screen.getByRole('option', { name: 'Planner · DeepSeek Best plans' });
  expect(planner.getAttribute('aria-selected')).toBe('true');
  expect(combobox.getAttribute('aria-activedescendant')).toBe(planner.id);
  await user.keyboard('{ArrowDown}');
  const executor = screen.getByRole('option', { name: 'Executor · Qwen Fast' });
  expect(combobox.getAttribute('aria-activedescendant')).toBe(executor.id);
  expect(document.activeElement).toBe(combobox);
  await user.keyboard('{Enter}');
  expect(onChange).toHaveBeenCalledWith('executor');
  expect(combobox.getAttribute('aria-expanded')).toBe('false');
  expect(combobox.textContent).toBe('Executor · Qwen');
});

test('Select picks an option by click, ignores disabled ones and closes on Escape', async () => {
  const user = userEvent.setup();
  const onChange = mock((_value: string) => {});
  render(<ModelSelect onChange={onChange} />);
  const combobox = screen.getByRole('combobox', { name: 'Default model' });
  await user.click(combobox);
  await user.click(screen.getByRole('option', { name: 'Vision model' }));
  expect(onChange).not.toHaveBeenCalled();
  await user.keyboard('{Escape}');
  expect(combobox.getAttribute('aria-expanded')).toBe('false');
  await user.click(combobox);
  await user.click(screen.getByRole('option', { name: 'Executor · Qwen Fast' }));
  expect(onChange).toHaveBeenCalledWith('executor');
  expect(document.activeElement).toBe(combobox);
});

test('Popover moves focus inside and Escape returns it; Escape in a nested menu closes only the menu', async () => {
  const user = userEvent.setup();
  render(
    <Popover label="Credits" trigger={props => <Button {...props}>Credits</Button>}>
      <Menu
        items={[{ kind: 'item', id: 'buy', label: 'Buy credits', onSelect: () => {} }]}
        trigger={props => <Button {...props}>More</Button>}
      />
    </Popover>,
  );
  const trigger = screen.getByRole('button', { name: 'Credits' });
  await user.click(trigger);
  const dialog = screen.getByRole('dialog', { name: 'Credits' });
  expect(document.activeElement).toBe(dialog);
  await user.click(screen.getByRole('button', { name: 'More' }));
  expect(screen.getByRole('menu')).toBeTruthy();
  await user.keyboard('{Escape}');
  expect(screen.getByRole('button', { name: 'More' }).getAttribute('aria-expanded')).toBe('false');
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  await user.keyboard('{Escape}');
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(trigger);
});

test('Tooltip appears after the delay on hover and focus, describes its anchor and hides on Escape', async () => {
  const user = userEvent.setup();
  render(
    <Tooltip content="Copies the task link" delay={0}>
      <IconButton icon={Copy} label="Copy" />
    </Tooltip>,
  );
  const button = screen.getByRole('button', { name: 'Copy' });
  await user.hover(button);
  const tip = await screen.findByRole('tooltip');
  expect(tip.textContent).toBe('Copies the task link');
  expect(button.getAttribute('aria-describedby')).toBe(tip.id);
  await user.unhover(button);
  await gone(() => screen.queryByRole('tooltip'));
  button.focus();
  await screen.findByRole('tooltip');
  await user.keyboard('{Escape}');
  await gone(() => screen.queryByRole('tooltip'));
  expect(document.activeElement).toBe(button);
});

test('Menu ignores arrow keys with modifiers and Tab closes it back to the trigger', async () => {
  const user = userEvent.setup();
  render(<TaskMenu onRename={() => {}} onDelete={() => {}} />);
  const trigger = screen.getByRole('button', { name: 'Task actions' });
  trigger.focus();
  expect(fireEvent.keyDown(trigger, { key: 'ArrowDown', metaKey: true })).toBe(true);
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  await user.keyboard('{Enter}');
  const rename = screen.getByRole('menuitem', { name: 'Rename R' });
  expect(document.activeElement).toBe(rename);
  for (const modifier of ['altKey', 'ctrlKey', 'metaKey'] as const) {
    expect(fireEvent.keyDown(rename, { key: 'ArrowDown', [modifier]: true })).toBe(true);
    expect(fireEvent.keyDown(rename, { key: 'End', [modifier]: true })).toBe(true);
  }
  expect(document.activeElement).toBe(rename);
  await user.keyboard('{Tab}');
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(trigger);
});

test('Menu focuses the first item when opened by a click that does not focus the trigger (Safari, Firefox)', async () => {
  render(<TaskMenu onRename={() => {}} onDelete={() => {}} />);
  const trigger = screen.getByRole('button', { name: 'Task actions' });
  fireEvent.click(trigger);
  await waitFor(() => {
    if (document.activeElement !== screen.queryByRole('menuitem', { name: 'Rename R' })) throw new Error('not focused');
  });
  // Повторный клик по кнопке закрывает меню и возвращает фокус на неё, а не теряет его вместе с пунктом.
  fireEvent.click(trigger);
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(trigger);
});

test('an outside click leaves focus where it went instead of pulling it back to the trigger', async () => {
  const user = userEvent.setup();
  render(<TaskMenu onRename={() => {}} onDelete={() => {}} />);
  await user.click(screen.getByRole('button', { name: 'Task actions' }));
  const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
  await user.click(elsewhere);
  await gone(() => screen.queryByRole('menu'));
  expect(document.activeElement).toBe(elsewhere);
});

test('Select ignores modified arrows, ignores Enter during IME composition and focuses itself when opened by a click', async () => {
  const onChange = mock((_value: string) => {});
  render(<ModelSelect onChange={onChange} />);
  const combobox = screen.getByRole('combobox', { name: 'Default model' });
  expect(fireEvent.keyDown(combobox, { key: 'ArrowDown', ctrlKey: true })).toBe(true);
  expect(combobox.getAttribute('aria-expanded')).toBe('false');
  // Клик без фокуса (Safari): дальше клавиатура должна работать, значит фокус ставится явно.
  fireEvent.click(combobox);
  expect(combobox.getAttribute('aria-expanded')).toBe('true');
  expect(document.activeElement).toBe(combobox);
  const active = combobox.getAttribute('aria-activedescendant');
  for (const modifier of ['altKey', 'ctrlKey', 'metaKey'] as const) {
    expect(fireEvent.keyDown(combobox, { key: 'ArrowDown', [modifier]: true })).toBe(true);
    expect(fireEvent.keyDown(combobox, { key: 'Home', [modifier]: true })).toBe(true);
  }
  expect(combobox.getAttribute('aria-activedescendant')).toBe(active);
  fireEvent.keyDown(combobox, { key: 'ArrowDown' });
  fireEvent.keyDown(combobox, { key: 'Enter', isComposing: true });
  expect(combobox.getAttribute('aria-expanded')).toBe('true');
  expect(onChange).not.toHaveBeenCalled();
});

const captureOf = (options: unknown) =>
  typeof options === 'boolean' ? options : Boolean((options as { capture?: boolean } | undefined)?.capture);

/**
 * Слушатели на window и document, добавленные после вызова и ещё не снятые. Методы подменяются
 * у самих объектов: в happy-dom у window (globalThis и defaultView) они свои, а не из EventTarget.prototype.
 */
function trackGlobalListeners() {
  type Method = EventTarget['addEventListener'];
  const targets = [...new Set<EventTarget>([document, window, document.defaultView!])];
  const active: Array<{ target: EventTarget; type: string; listener: unknown; capture: boolean }> = [];
  const originals = targets.map(target => {
    const own = {
      add: Object.getOwnPropertyDescriptor(target, 'addEventListener'),
      remove: Object.getOwnPropertyDescriptor(target, 'removeEventListener'),
    };
    const add = target.addEventListener.bind(target);
    const remove = target.removeEventListener.bind(target);
    const tracked: { add: Method; remove: Method } = {
      add: (type, listener, options) => {
        active.push({ target, type, listener, capture: captureOf(options) });
        add(type, listener, options);
      },
      remove: (type, listener, options) => {
        const index = active.findIndex(
          entry =>
            entry.target === target &&
            entry.type === type &&
            entry.listener === listener &&
            entry.capture === captureOf(options),
        );
        if (index >= 0) active.splice(index, 1);
        remove(type, listener, options);
      },
    };
    Object.defineProperty(target, 'addEventListener', { configurable: true, writable: true, value: tracked.add });
    Object.defineProperty(target, 'removeEventListener', { configurable: true, writable: true, value: tracked.remove });
    return { target, own };
  });
  return {
    types: () => active.map(entry => entry.type).toSorted(),
    restore() {
      for (const { target, own } of originals) {
        for (const [name, descriptor] of [
          ['addEventListener', own.add],
          ['removeEventListener', own.remove],
        ] as const) {
          if (descriptor) Object.defineProperty(target, name, descriptor);
          else delete (target as unknown as Record<string, unknown>)[name];
        }
      }
    },
  };
}

test('unmounting open layers removes every document and window listener', async () => {
  const listeners = trackGlobalListeners();
  try {
    const view = render(
      <>
        <TaskMenu onRename={() => {}} onDelete={() => {}} />
        <ModelSelect onChange={() => {}} />
        <Popover label="Credits" trigger={props => <Button {...props}>Credits</Button>}>
          Body
        </Popover>
        <Tooltip content="Copies the task link" delay={0}>
          <IconButton icon={Copy} label="Copy" />
        </Tooltip>
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Task actions' }));
    fireEvent.click(screen.getByRole('combobox', { name: 'Default model' }));
    fireEvent.click(screen.getByRole('button', { name: 'Credits' }));
    screen.getByRole('button', { name: 'Copy' }).focus();
    await screen.findByRole('tooltip');
    await waitFor(() => {
      if (screen.getByRole('menu').dataset.placement === undefined) throw new Error('not positioned');
    });
    expect(listeners.types()).toContain('keydown');
    view.unmount();
    expect(listeners.types()).toEqual([]);
  } finally {
    listeners.restore();
  }
});
