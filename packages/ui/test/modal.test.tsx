import { expect, mock, test } from 'bun:test';
import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { options } from 'preact';
import { useState } from 'preact/hooks';
import { Copy, Settings, SquarePen } from 'lucide-preact';
import {
  Button,
  CommandPalette,
  ConfirmDialog,
  Dialog,
  filterCommands,
  IconButton,
  Input,
  Popover,
  Select,
  Sheet,
  Tooltip,
  useHotkey,
  type CommandGroup,
} from '../src/index.ts';
import { gone, trackGlobalListeners } from './helpers.ts';

function KeyDialog() {
  const [open, setOpen] = useState(false);
  const [expiry, setExpiry] = useState<'30' | '90' | undefined>('30');
  return (
    <>
      <Button onClick={() => setOpen(true)}>Create key</Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Create API key"
        description="Keys let your code start tasks."
        footer={<Button variant="primary">Create</Button>}
      >
        <Input aria-label="Name" />
        <Select
          label="Expires"
          value={expiry}
          onChange={setExpiry}
          options={[
            { value: '30', label: 'In 30 days' },
            { value: '90', label: 'In 90 days' },
          ]}
        />
      </Dialog>
    </>
  );
}

test('Dialog moves focus to the first field, traps Tab and returns focus on Escape', async () => {
  const user = userEvent.setup();
  render(<KeyDialog />);
  const opener = screen.getByRole('button', { name: 'Create key' });
  await user.click(opener);
  const dialog = screen.getByRole('dialog', { name: 'Create API key' });
  expect(dialog.getAttribute('aria-modal')).toBe('true');
  expect(dialog.getAttribute('aria-describedby')).toBe(screen.getByText('Keys let your code start tasks.').id);
  expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Name' }));
  expect(document.body.style.overflow).toBe('hidden');
  await user.keyboard('{Shift>}{Tab}{/Shift}');
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Name' }));
  await user.keyboard('{Escape}');
  expect(document.activeElement).toBe(opener);
  expect(document.body.style.overflow).toBe('');
  await gone(() => screen.queryByRole('dialog'));
});

test('a click on the backdrop closes the dialog, a click inside does not', async () => {
  const user = userEvent.setup();
  render(<KeyDialog />);
  await user.click(screen.getByRole('button', { name: 'Create key' }));
  const dialog = screen.getByRole('dialog');
  await user.click(screen.getByRole('textbox', { name: 'Name' }));
  expect(dialog.closest('.ui-overlay')?.getAttribute('data-state')).not.toBe('closed');
  fireEvent.pointerDown(dialog.closest('.ui-overlay')!);
  await gone(() => screen.queryByRole('dialog'));
});

test('a select inside a dialog renders its list in the dialog layer, and Escape closes only the list', async () => {
  const user = userEvent.setup();
  render(<KeyDialog />);
  await user.click(screen.getByRole('button', { name: 'Create key' }));
  const combobox = screen.getByRole('combobox', { name: 'Expires' });
  await user.click(combobox);
  const listbox = screen.getByRole('listbox');
  expect(screen.getByRole('dialog').closest('.ui-overlay')!.contains(listbox)).toBe(true);
  await user.keyboard('{Escape}');
  expect(combobox.getAttribute('aria-expanded')).toBe('false');
  expect(screen.getByRole('dialog', { name: 'Create API key' })).toBeTruthy();
});

function DeleteTask({ onConfirm }: { onConfirm(): void }) {
  const [open, setOpen] = useState(true);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={setOpen}
      title="Delete this task?"
      description="This can't be undone."
      confirmLabel="Delete task"
      onConfirm={onConfirm}
    />
  );
}

test('ConfirmDialog is an alertdialog focused on Cancel that ignores outside clicks', async () => {
  const user = userEvent.setup();
  const onConfirm = mock(() => {});
  render(<DeleteTask onConfirm={onConfirm} />);
  const dialog = await screen.findByRole('alertdialog', { name: 'Delete this task?' });
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  fireEvent.pointerDown(dialog.closest('.ui-overlay')!);
  expect(screen.getByRole('alertdialog')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Delete task' }));
  expect(onConfirm).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  await gone(() => screen.queryByRole('alertdialog'));
});

function TaskDetails() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Details</Button>
      <Sheet open={open} onOpenChange={setOpen} title="Task details">
        <p>Completed</p>
      </Sheet>
    </>
  );
}

test('Sheet is a modal dialog with a close button', async () => {
  const user = userEvent.setup();
  render(<TaskDetails />);
  await user.click(screen.getByRole('button', { name: 'Details' }));
  expect(screen.getByRole('dialog', { name: 'Task details' }).getAttribute('aria-modal')).toBe('true');
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
  await user.click(screen.getByRole('button', { name: 'Close' }));
  await gone(() => screen.queryByRole('dialog'));
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Details' }));
});

const groups = (onNew: () => void, onSettings: () => void): CommandGroup[] => [
  {
    label: 'Actions',
    items: [
      { id: 'new', label: 'New task', icon: SquarePen, shortcut: ['⌘', 'O'], onSelect: onNew },
      { id: 'settings', label: 'Open settings', icon: Settings, keywords: 'preferences', onSelect: onSettings },
    ],
  },
  { label: 'Recent tasks', items: [{ id: 't1', label: 'Compare agent frameworks', onSelect: () => {} }] },
];

test('filterCommands matches labels and keywords and drops empty groups', () => {
  const result = filterCommands(
    groups(
      () => {},
      () => {},
    ),
    ' PREFER',
  );
  expect(result.map(g => [g.label, g.items.map(i => i.id)])).toEqual([['Actions', ['settings']]]);
});

function Palette({ onSettings }: { onSettings(): void }) {
  const [open, setOpen] = useState(false);
  useHotkey('k', () => setOpen(true), { mod: true });
  return <CommandPalette open={open} onOpenChange={setOpen} groups={groups(() => {}, onSettings)} />;
}

test('⌘K opens the palette; typing filters, arrows move the active option, Enter runs it', async () => {
  const user = userEvent.setup();
  const onSettings = mock(() => {});
  render(<Palette onSettings={onSettings} />);
  await user.keyboard('{Meta>}k{/Meta}');
  const input = screen.getByRole('combobox', { name: 'Command palette' });
  expect(document.activeElement).toBe(input);
  expect(input.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', { name: 'New task ⌘ O' }).id);
  await user.keyboard('{ArrowDown}');
  expect(input.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', { name: 'Open settings' }).id);
  await user.keyboard('zzz');
  expect(screen.getByText('No results')).toBeTruthy();
  await user.clear(input);
  await user.keyboard('settings{Enter}');
  expect(onSettings).toHaveBeenCalledTimes(1);
  await gone(() => screen.queryByRole('dialog'));
});

function NestedDialogs() {
  const [outer, setOuter] = useState(false);
  const [inner, setInner] = useState(false);
  return (
    <>
      <Button onClick={() => setOuter(true)}>Open outer</Button>
      <Dialog open={outer} onOpenChange={setOuter} title="Outer">
        <Button onClick={() => setInner(true)}>Open inner</Button>
        <Dialog open={inner} onOpenChange={setInner} title="Inner">
          <Input aria-label="Inner field" />
        </Dialog>
      </Dialog>
    </>
  );
}

test('nested dialogs: Tab and Escape belong to the top one, the scroll lock is counted and restored', async () => {
  const user = userEvent.setup();
  const body = document.body.style;
  body.overflow = 'auto';
  body.paddingRight = '3px';
  // Полоса прокрутки 15 px: happy-dom не считает раскладку, clientWidth задаём сами.
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1009 });
  try {
    render(<NestedDialogs />);
    await user.click(screen.getByRole('button', { name: 'Open outer' }));
    expect(body.overflow).toBe('hidden');
    expect(body.paddingRight).toBe('18px');
    await user.click(screen.getByRole('button', { name: 'Open inner' }));
    const field = screen.getByRole('textbox', { name: 'Inner field' });
    expect(document.activeElement).toBe(field);
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(field);
    await user.keyboard('{Escape}');
    await gone(() => screen.queryByRole('dialog', { name: 'Inner' }));
    expect(screen.getByRole('dialog', { name: 'Outer' })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open inner' }));
    expect(body.overflow).toBe('hidden');
    await user.tab();
    expect(document.activeElement).toBe(screen.getAllByRole('button', { name: 'Close' })[0]!);
    await user.keyboard('{Escape}');
    await gone(() => screen.queryByRole('dialog'));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open outer' }));
    expect(body.overflow).toBe('auto');
    expect(body.paddingRight).toBe('3px');
  } finally {
    Reflect.deleteProperty(document.documentElement, 'clientWidth');
    body.overflow = '';
    body.paddingRight = '';
  }
});

function Host({ shown }: { shown: boolean }) {
  return (
    <>
      <Button>Opener</Button>
      {shown && (
        <>
          <Dialog open onOpenChange={() => {}} title="Mounted">
            <Input aria-label="Name" />
          </Dialog>
          <Sheet open onOpenChange={() => {}} title="Side" />
          <CommandPalette
            open
            onOpenChange={() => {}}
            groups={groups(
              () => {},
              () => {},
            )}
          />
        </>
      )}
    </>
  );
}

test('unmounting open layers releases listeners, the scroll lock, the focus trap and the dismiss stack', async () => {
  const user = userEvent.setup();
  const listeners = trackGlobalListeners();
  try {
    const view = render(<Host shown={false} />);
    const opener = screen.getByRole('button', { name: 'Opener' });
    opener.focus();
    view.rerender(<Host shown />);
    await waitFor(() => {
      if (document.activeElement === opener) throw new Error('focus not trapped yet');
    });
    expect(document.body.style.overflow).toBe('hidden');
    expect(listeners.types()).toContain('keydown');
    view.rerender(<Host shown={false} />);
    expect(listeners.types()).toEqual([]);
    expect(document.body.style.overflow).toBe('');
    expect(document.activeElement).toBe(opener);
  } finally {
    listeners.restore();
  }
  // Стеки ловушек и слоёв пусты: новый диалог получает Tab и Esc.
  render(<KeyDialog />);
  await user.click(screen.getByRole('button', { name: 'Create key' }));
  await user.keyboard('{Shift>}{Tab}{/Shift}');
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
  await user.keyboard('{Escape}');
  await gone(() => screen.queryByRole('dialog'));
});

test('ConfirmDialog closes on Escape', async () => {
  const user = userEvent.setup();
  render(<DeleteTask onConfirm={() => {}} />);
  await screen.findByRole('alertdialog');
  await user.keyboard('{Escape}');
  await gone(() => screen.queryByRole('alertdialog'));
});

test('Sheet closes on Escape and on a click on its backdrop, returning focus', async () => {
  const user = userEvent.setup();
  render(<TaskDetails />);
  const opener = screen.getByRole('button', { name: 'Details' });
  await user.click(opener);
  await user.keyboard('{Escape}');
  await gone(() => screen.queryByRole('dialog'));
  expect(document.activeElement).toBe(opener);
  await user.click(opener);
  fireEvent.pointerDown(document.querySelector('.ui-overlay')!);
  await gone(() => screen.queryByRole('dialog'));
  expect(document.activeElement).toBe(opener);
});

test('Escape on a tooltip inside a dialog hides only the tooltip', async () => {
  const user = userEvent.setup();
  const onOpenChange = mock(() => {});
  render(
    <Dialog open onOpenChange={onOpenChange} title="Share">
      <Tooltip content="Copies the task link" delay={0}>
        <IconButton icon={Copy} label="Copy" />
      </Tooltip>
    </Dialog>,
  );
  await screen.findByRole('tooltip');
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Copy' }));
  await user.keyboard('{Escape}');
  await gone(() => screen.queryByRole('tooltip'));
  expect(onOpenChange).not.toHaveBeenCalled();
  await user.keyboard('{Escape}');
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

function PaletteWithOpener({ onNew, onSettings }: { onNew(): void; onSettings(): void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Commands</Button>
      <CommandPalette open={open} onOpenChange={setOpen} groups={groups(onNew, onSettings)} />
    </>
  );
}

test('CommandPalette: groups are named, modified arrows and IME keys are ignored, clicks run options', async () => {
  const user = userEvent.setup();
  const onNew = mock(() => {});
  const onSettings = mock(() => {});
  render(<PaletteWithOpener onNew={onNew} onSettings={onSettings} />);
  const opener = screen.getByRole('button', { name: 'Commands' });
  await user.click(opener);
  expect(screen.getByRole('group', { name: 'Recent tasks' })).toBeTruthy();
  const input = screen.getByRole('combobox', { name: 'Command palette' });
  const first = screen.getByRole('option', { name: 'New task ⌘ O' }).id;
  fireEvent.keyDown(input, { key: 'ArrowDown', altKey: true });
  expect(input.getAttribute('aria-activedescendant')).toBe(first);
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
  fireEvent.keyDown(input, { key: 'Escape', isComposing: true });
  expect(onNew).not.toHaveBeenCalled();
  expect(input.closest('.ui-overlay')?.getAttribute('data-state')).not.toBe('closed');
  await user.keyboard('{Escape}');
  await gone(() => screen.queryByRole('dialog'));
  expect(document.activeElement).toBe(opener);
  await user.click(opener);
  await user.click(screen.getByRole('option', { name: 'Open settings' }));
  expect(onSettings).toHaveBeenCalledTimes(1);
  await gone(() => screen.queryByRole('dialog'));
  expect(document.activeElement).toBe(opener);
});

function Hotkeys({ onSlash, onK, enabled }: { onSlash(): void; onK(): void; enabled: boolean }) {
  useHotkey('/', onSlash, { enabled });
  useHotkey('k', onK, { mod: true, enabled });
  return (
    <>
      <Input aria-label="Search" />
      <textarea aria-label="Notes" />
    </>
  );
}

test('useHotkey skips typing in fields unless it is a mod hotkey, ignores IME and can be disabled', async () => {
  const user = userEvent.setup();
  const onSlash = mock(() => {});
  const onK = mock(() => {});
  const view = render(<Hotkeys onSlash={onSlash} onK={onK} enabled />);
  await user.keyboard('/');
  expect(onSlash).toHaveBeenCalledTimes(1);
  await user.keyboard('{Meta>}/{/Meta}');
  await user.keyboard('k');
  expect(onSlash).toHaveBeenCalledTimes(1);
  expect(onK).not.toHaveBeenCalled();
  await user.click(screen.getByRole('textbox', { name: 'Search' }));
  await user.keyboard('/');
  await user.click(screen.getByRole('textbox', { name: 'Notes' }));
  await user.keyboard('/');
  expect(onSlash).toHaveBeenCalledTimes(1);
  await user.keyboard('{Control>}k{/Control}');
  expect(onK).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(document.body, { key: 'k', metaKey: true, isComposing: true });
  expect(onK).toHaveBeenCalledTimes(1);
  view.rerender(<Hotkeys onSlash={onSlash} onK={onK} enabled={false} />);
  fireEvent.keyDown(document.body, { key: 'k', metaKey: true });
  fireEvent.keyDown(document.body, { key: '/' });
  expect(onK).toHaveBeenCalledTimes(1);
  expect(onSlash).toHaveBeenCalledTimes(1);
});

test('Shift+Tab from the dialog panel itself wraps to the last tabbable', async () => {
  const user = userEvent.setup();
  render(<KeyDialog />);
  await user.click(screen.getByRole('button', { name: 'Create key' }));
  const dialog = screen.getByRole('dialog', { name: 'Create API key' });
  dialog.focus();
  await user.keyboard('{Shift>}{Tab}{/Shift}');
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
});

test('a dialog without tabbables keeps focus on its panel for Tab and Shift+Tab', async () => {
  const user = userEvent.setup();
  render(
    <>
      <Button>Outside</Button>
      <Dialog open onOpenChange={() => {}} role="alertdialog" title="Working…" />
    </>,
  );
  const dialog = await screen.findByRole('alertdialog');
  await waitFor(() => {
    if (document.activeElement !== dialog) throw new Error('not focused yet');
  });
  await user.tab();
  expect(document.activeElement).toBe(dialog);
  await user.keyboard('{Shift>}{Tab}{/Shift}');
  expect(document.activeElement).toBe(dialog);
});

test('CommandPalette announces the result count and the empty state in a status region', async () => {
  const user = userEvent.setup();
  render(<PaletteWithOpener onNew={() => {}} onSettings={() => {}} />);
  await user.click(screen.getByRole('button', { name: 'Commands' }));
  const status = screen.getByRole('status');
  expect(screen.getByRole('listbox').contains(status)).toBe(false);
  await user.keyboard('set');
  expect(status.textContent).toBe('1 result');
  await user.keyboard('zzz');
  expect(status.textContent).toBe('No results');
});

test('palette option ids come from their position, so odd and duplicate item ids still work', async () => {
  const user = userEvent.setup();
  const onFirst = mock(() => {});
  const onSecond = mock(() => {});
  const odd: CommandGroup[] = [
    { label: 'One', items: [{ id: 'same id', label: 'First', onSelect: onFirst }] },
    { label: 'Two', items: [{ id: 'same id', label: 'Second', onSelect: onSecond }] },
  ];
  render(<CommandPalette open onOpenChange={() => {}} groups={odd} />);
  const input = await screen.findByRole('combobox');
  const first = screen.getByRole('option', { name: 'First' });
  const second = screen.getByRole('option', { name: 'Second' });
  expect(first.id).not.toBe(second.id);
  expect(first.id).not.toContain(' ');
  await user.keyboard('{ArrowDown}');
  expect(input.getAttribute('aria-activedescendant')).toBe(second.id);
  expect(second.getAttribute('aria-selected')).toBe('true');
  expect(first.getAttribute('aria-selected')).toBe('false');
  await user.click(second);
  expect(onSecond).toHaveBeenCalledTimes(1);
  expect(onFirst).not.toHaveBeenCalled();
});

test('a reopened palette renders with an empty query from its first frame', async () => {
  const user = userEvent.setup();
  render(<PaletteWithOpener onNew={() => {}} onSettings={() => {}} />);
  const opener = screen.getByRole('button', { name: 'Commands' });
  await user.click(opener);
  await user.keyboard('zzz{Escape}');
  await gone(() => screen.queryByRole('dialog'));
  // Каждый коммит рендера: запоминаем, что было в поле, когда палитра впервые появилась в DOM.
  // Сброс эффектом успел бы показать старый фильтр на один коммит.
  let firstValue: string | undefined;
  const previous = options.diffed;
  options.diffed = vnode => {
    previous?.(vnode);
    firstValue ??= document.querySelector<HTMLInputElement>('[role="combobox"]')?.value;
  };
  try {
    await user.click(opener);
  } finally {
    options.diffed = previous;
  }
  expect(firstValue).toBe('');
  expect(screen.getAllByRole('option')).toHaveLength(3);
  await user.keyboard('{Escape}');
  await gone(() => screen.queryByRole('dialog'));
});

test('palette Enter with keyCode 229 (IME in Safari) does not run the active option', async () => {
  const onNew = mock(() => {});
  render(<CommandPalette open onOpenChange={() => {}} groups={groups(onNew, () => {})} />);
  const input = await screen.findByRole('combobox');
  fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
  expect(onNew).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(onNew).toHaveBeenCalledTimes(1);
});

test('mod hotkeys match the physical key on other layouts, need exact modifiers and ignore repeats', () => {
  const onK = mock(() => {});
  const onShiftK = mock(() => {});
  function Keys() {
    useHotkey('k', onK, { mod: true });
    useHotkey('k', onShiftK, { mod: true, shift: true });
    return null;
  }
  render(<Keys />);
  fireEvent.keyDown(document.body, { key: 'л', code: 'KeyK', metaKey: true });
  expect(onK).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(document.body, { key: 'K', code: 'KeyK', metaKey: true, shiftKey: true });
  expect(onK).toHaveBeenCalledTimes(1);
  expect(onShiftK).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(document.body, { key: 'k', code: 'KeyK', ctrlKey: true, altKey: true });
  fireEvent.keyDown(document.body, { key: 'k', code: 'KeyK', metaKey: true, repeat: true });
  // Латинская раскладка с другой буквой на месте K (Dvorak) — по букве, а не по месту клавиши.
  fireEvent.keyDown(document.body, { key: 't', code: 'KeyK', metaKey: true });
  expect(onK).toHaveBeenCalledTimes(1);
});

test('ConfirmDialog busy: the confirm button shows aria-busy and ignores clicks', async () => {
  const user = userEvent.setup();
  const onConfirm = mock(() => {});
  render(
    <ConfirmDialog
      open
      onOpenChange={() => {}}
      title="Delete this task?"
      confirmLabel="Delete task"
      onConfirm={onConfirm}
      busy
    />,
  );
  const confirm = await screen.findByRole('button', { name: 'Delete task' });
  expect(confirm.getAttribute('aria-busy')).toBe('true');
  await user.click(confirm);
  expect(onConfirm).not.toHaveBeenCalled();
});

function FiltersDialog({ popoverFirst = false }: { popoverFirst?: boolean }) {
  const range = (
    <Popover label="Range" trigger={props => <Button {...props}>Range</Button>}>
      <Input aria-label="From" />
      <Input aria-label="To" />
    </Popover>
  );
  return (
    <Dialog open onOpenChange={() => {}} title="Filters">
      {popoverFirst && range}
      <Input aria-label="Query" />
      {!popoverFirst && range}
    </Dialog>
  );
}

test('Tab in a popover inside a dialog moves between its fields, and Tab in the dialog still wraps', async () => {
  const user = userEvent.setup();
  render(<FiltersDialog />);
  const query = await screen.findByRole('textbox', { name: 'Query' });
  await waitFor(() => {
    if (document.activeElement !== query) throw new Error('focus not trapped yet');
  });
  const range = screen.getByRole('button', { name: 'Range' });
  await user.click(range);
  const from = screen.getByRole('textbox', { name: 'From' });
  await user.click(from);
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'To' }));
  await user.keyboard('{Shift>}{Tab}{/Shift}');
  expect(document.activeElement).toBe(from);
  // Tab с последнего поля закрывает поповер и возвращает фокус на кнопку — ловушка его не перехватывает.
  await user.tab();
  await user.tab();
  expect(document.activeElement).toBe(range);
  expect(range.getAttribute('aria-expanded')).toBe('false');
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
  await user.tab();
  expect(document.activeElement).toBe(query);
});

test('Shift+Tab out of a popover returns focus to its trigger even when the trigger is first in the dialog', async () => {
  const user = userEvent.setup();
  render(<FiltersDialog popoverFirst />);
  const range = await screen.findByRole('button', { name: 'Range' });
  await waitFor(() => {
    if (document.activeElement !== range) throw new Error('focus not trapped yet');
  });
  await user.click(range);
  await user.click(screen.getByRole('textbox', { name: 'From' }));
  // Поповер уже обработал Shift+Tab (preventDefault) — ловушка не переносит фокус на последний элемент.
  await user.keyboard('{Shift>}{Tab}{/Shift}');
  expect(document.activeElement).toBe(range);
  expect(range.getAttribute('aria-expanded')).toBe('false');
});

function BusyConfirm({ onOpenChange }: { onOpenChange(open: boolean): void }) {
  return (
    <ConfirmDialog
      open
      onOpenChange={onOpenChange}
      title="Delete this task?"
      confirmLabel="Delete task"
      onConfirm={() => {}}
      busy
    />
  );
}

test('ConfirmDialog busy ignores Escape and disables Cancel', async () => {
  const user = userEvent.setup();
  const onOpenChange = mock((_open: boolean) => {});
  render(<BusyConfirm onOpenChange={onOpenChange} />);
  const cancel = (await screen.findByRole('button', { name: 'Cancel' })) as HTMLButtonElement;
  expect(cancel.disabled).toBe(true);
  const confirm = screen.getByRole('button', { name: 'Delete task' });
  await waitFor(() => {
    if (document.activeElement !== confirm) throw new Error('focus is not on the confirm button');
  });
  await user.keyboard('{Escape}');
  expect(onOpenChange).not.toHaveBeenCalled();
  expect(screen.getByRole('alertdialog')).toBeTruthy();
});

function PaletteOverDialog({ dialog, palette }: { dialog: boolean; palette: boolean }) {
  return (
    <>
      <Button>Opener</Button>
      <Dialog open={dialog} onOpenChange={() => {}} title="Settings">
        <Button>Inside</Button>
      </Dialog>
      <CommandPalette
        open={palette}
        onOpenChange={() => {}}
        groups={groups(
          () => {},
          () => {},
        )}
      />
    </>
  );
}

test('closing a dialog under an open palette leaves focus in the palette, and the palette returns it to the opener', async () => {
  const view = render(<PaletteOverDialog dialog={false} palette={false} />);
  const opener = screen.getByRole('button', { name: 'Opener' });
  opener.focus();
  view.rerender(<PaletteOverDialog dialog palette={false} />);
  const inside = await screen.findByRole('button', { name: 'Inside' });
  await waitFor(() => {
    if (document.activeElement !== inside) throw new Error('focus not trapped yet');
  });
  view.rerender(<PaletteOverDialog dialog palette />);
  const search = await screen.findByRole('combobox', { name: 'Command palette' });
  await waitFor(() => {
    if (document.activeElement !== search) throw new Error('palette not focused yet');
  });
  view.rerender(<PaletteOverDialog dialog={false} palette />);
  expect(document.activeElement).toBe(search);
  await gone(() => screen.queryByRole('dialog', { name: 'Settings' }));
  view.rerender(<PaletteOverDialog dialog={false} palette={false} />);
  expect(document.activeElement).toBe(opener);
});

function EditWithConfirm({ edit, confirm }: { edit: boolean; confirm: boolean }) {
  return (
    <>
      <Button>Opener</Button>
      <Dialog open={edit} onOpenChange={() => {}} title="Edit">
        <Button>Discard</Button>
        <ConfirmDialog
          open={confirm}
          onOpenChange={() => {}}
          title="Discard changes?"
          confirmLabel="Discard"
          onConfirm={() => {}}
        />
      </Dialog>
    </>
  );
}

test('a dialog closing under its nested confirm hands its opener to the confirm, so focus ends on the opener', async () => {
  const view = render(<EditWithConfirm edit={false} confirm={false} />);
  const opener = screen.getByRole('button', { name: 'Opener' });
  opener.focus();
  view.rerender(<EditWithConfirm edit confirm={false} />);
  const discard = await screen.findByRole('button', { name: 'Discard' });
  await waitFor(() => {
    if (document.activeElement !== discard) throw new Error('focus not trapped yet');
  });
  view.rerender(<EditWithConfirm edit confirm />);
  const cancel = await screen.findByRole('button', { name: 'Cancel' });
  await waitFor(() => {
    if (document.activeElement !== cancel) throw new Error('confirm not focused yet');
  });
  // Родитель закрывается, пока подтверждение (портал в его overlay) ещё открыто.
  view.rerender(<EditWithConfirm edit={false} confirm />);
  await gone(() => screen.queryByRole('dialog', { name: 'Edit' }));
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(document.activeElement).toBe(opener);
});
