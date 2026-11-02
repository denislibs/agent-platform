import { expect, mock, test } from 'bun:test';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { useState } from 'preact/hooks';
import { Copy, Pencil, Trash2 } from 'lucide-preact';
import { Button, DURATION_MS, IconButton, Menu, Popover, Select, Tooltip, type MenuEntry } from '../src/index.ts';
import { gone, trackGlobalListeners } from './helpers.ts';

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

test('Tooltip does not describe its anchor with text that repeats the accessible name', async () => {
  render(
    <>
      <Tooltip content="Copy" delay={0}>
        <IconButton icon={Copy} label="Copy" />
      </Tooltip>
      <Tooltip content="Save" delay={0}>
        <Button>Save</Button>
      </Tooltip>
    </>,
  );
  const copy = screen.getByRole('button', { name: 'Copy' });
  copy.focus();
  expect((await screen.findByRole('tooltip')).textContent).toBe('Copy');
  expect(copy.hasAttribute('aria-describedby')).toBe(false);
  const save = screen.getByRole('button', { name: 'Save' });
  save.focus();
  await waitFor(() => {
    if (screen.queryByRole('tooltip')?.textContent !== 'Save') throw new Error('no tooltip yet');
  });
  expect(save.hasAttribute('aria-describedby')).toBe(false);
});

const has = (el: Element, ...names: string[]) => names.every(name => el.classList.contains(name));

test('Menu, Select, Popover and Tooltip merge class and className into their own classes', async () => {
  render(
    <>
      <Menu
        class="extra-a"
        className="extra-b"
        items={[{ kind: 'item', id: 'one', label: 'One', onSelect: () => {} }]}
        trigger={props => <Button {...props}>Open menu</Button>}
      />
      <Select
        class="extra-a"
        className="extra-b"
        label="Pick"
        value={undefined}
        onChange={() => {}}
        options={[{ value: 'a', label: 'A' }]}
      />
      <Popover
        class="extra-a"
        className="extra-b"
        label="Panel"
        trigger={props => <Button {...props}>Open panel</Button>}
      >
        Body
      </Popover>
      <Tooltip class="extra-a" className="extra-b" content="Hint" delay={0}>
        <Button>Hinted</Button>
      </Tooltip>
    </>,
  );
  expect(
    has(screen.getByRole('combobox', { name: 'Pick' }), 'ui-input', 'ui-select-trigger', 'extra-a', 'extra-b'),
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
  expect(has(screen.getByRole('menu'), 'ui-floating', 'ui-menu', 'extra-a', 'extra-b')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Open panel' }));
  expect(has(screen.getByRole('dialog', { name: 'Panel' }), 'ui-floating', 'ui-popover', 'extra-a', 'extra-b')).toBe(
    true,
  );
  screen.getByRole('button', { name: 'Hinted' }).focus();
  expect(has(await screen.findByRole('tooltip'), 'ui-tooltip', 'extra-a', 'extra-b')).toBe(true);
});

function CreditsPopover() {
  return (
    <>
      <Popover label="Credits" trigger={props => <Button {...props}>Credits</Button>}>
        <button type="button">First</button>
        <button type="button">Second</button>
      </Popover>
      <button type="button">After</button>
    </>
  );
}

test('Tab past the last control or Shift+Tab before the first closes the Popover and returns focus', async () => {
  const user = userEvent.setup();
  render(<CreditsPopover />);
  const trigger = screen.getByRole('button', { name: 'Credits' });
  await user.click(trigger);
  expect(document.activeElement).toBe(screen.getByRole('dialog', { name: 'Credits' }));
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'First' }));
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Second' }));
  await user.tab();
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(trigger);

  await user.click(trigger);
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'First' }));
  await user.tab({ shift: true });
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(trigger);
});

test('focus moved out of the Popover by other means closes it without pulling focus back', async () => {
  const user = userEvent.setup();
  render(<CreditsPopover />);
  const trigger = screen.getByRole('button', { name: 'Credits' });
  await user.click(trigger);
  const after = screen.getByRole('button', { name: 'After' });
  act(() => after.focus());
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(after);
});

test('Select returns focus to the combobox when Escape closes it', () => {
  render(<ModelSelect onChange={() => {}} />);
  const combobox = screen.getByRole('combobox', { name: 'Default model' });
  fireEvent.click(combobox);
  combobox.blur();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(combobox.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(combobox);
});

test('Menu arrows from the menu container go to the first or the last item', async () => {
  const user = userEvent.setup();
  render(<TaskMenu onRename={() => {}} onDelete={() => {}} />);
  await user.click(screen.getByRole('button', { name: 'Task actions' }));
  const menu = screen.getByRole('menu');
  menu.focus();
  await user.keyboard('{ArrowUp}');
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Delete' }));
  menu.focus();
  await user.keyboard('{ArrowDown}');
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Rename R' }));
});

/** Таймеры с заданной задержкой, которые ещё не сработали и не отменены. */
function trackTimers(delay: number) {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const pending = new Set<unknown>();
  globalThis.setTimeout = ((handler: () => void, ms?: number, ...args: unknown[]) => {
    if (ms !== delay) return realSet(handler, ms, ...args);
    const id = realSet(() => {
      pending.delete(id);
      handler();
    }, ms);
    pending.add(id);
    return id;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id?: Parameters<typeof clearTimeout>[0]) => {
    pending.delete(id);
    realClear(id);
  }) as typeof clearTimeout;
  return {
    pending: () => pending.size,
    restore() {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    },
  };
}

test('unmounting a Tooltip while its show delay runs cancels the timer', async () => {
  const delay = 777;
  const timers = trackTimers(delay);
  try {
    const view = render(
      <Tooltip content="Copies the task link" delay={delay}>
        <IconButton icon={Copy} label="Copy" />
      </Tooltip>,
    );
    screen.getByRole('button', { name: 'Copy' }).focus();
    await waitFor(() => {
      if (timers.pending() === 0) throw new Error('timer not scheduled yet');
    });
    view.unmount();
    expect(timers.pending()).toBe(0);
  } finally {
    timers.restore();
  }
});

test('reopening a layer during its exit animation keeps it mounted and open', async () => {
  const user = userEvent.setup();
  render(<TaskMenu onRename={() => {}} onDelete={() => {}} />);
  const trigger = screen.getByRole('button', { name: 'Task actions' });
  trigger.focus();
  await user.keyboard('{Enter}');
  const menu = screen.getByRole('menu');
  await waitFor(() => {
    if (menu.dataset.state !== 'open') throw new Error('not open yet');
  });
  await user.keyboard('{Escape}');
  expect(menu.dataset.state).toBe('closed');
  await user.keyboard('{Enter}');
  await new Promise(resolve => setTimeout(resolve, DURATION_MS.fast + 50));
  expect(screen.getByRole('menu')).toBe(menu);
  expect(menu.dataset.state).toBe('open');
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
});
