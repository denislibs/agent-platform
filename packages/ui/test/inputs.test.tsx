import { expect, mock, test } from 'bun:test';
import { act, fireEvent, render, screen } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { useState } from 'preact/hooks';
import {
  Dropzone,
  nextIndex,
  OtpInput,
  ShortcutInput,
  shortcutFromEvent,
  Stepper,
  TagInput,
  Tabs,
} from '../src/index.ts';

const none = () => false;

test('nextIndex wraps around, honours Home/End and skips disabled items', () => {
  expect(nextIndex('ArrowRight', 2, 3, none, 'horizontal')).toBe(0);
  expect(nextIndex('ArrowLeft', 0, 3, none, 'horizontal')).toBe(2);
  expect(nextIndex('ArrowDown', 0, 3, i => i === 1, 'vertical')).toBe(2);
  expect(nextIndex('End', 0, 3, i => i === 2, 'vertical')).toBe(1);
  expect(nextIndex('Home', 2, 3, none, 'vertical')).toBe(0);
  expect(nextIndex('ArrowDown', 0, 3, none, 'horizontal')).toBeNull();
  expect(nextIndex('ArrowUp', -1, 3, none, 'vertical')).toBe(2);
  expect(nextIndex('ArrowDown', -1, 3, none, 'vertical')).toBe(0);
  expect(nextIndex('ArrowRight', 0, 2, () => true, 'horizontal')).toBeNull();
});

function TabsHarness() {
  const [value, setValue] = useState<'tasks' | 'websites' | 'computers'>('tasks');
  return (
    <Tabs
      label="Usage"
      value={value}
      onChange={setValue}
      items={[
        { value: 'tasks', label: 'Tasks', panel: <p>Task usage</p> },
        { value: 'websites', label: 'Websites', disabled: true, panel: <p>Website usage</p> },
        { value: 'computers', label: 'Computers', count: 3, panel: <p>Computer usage</p> },
      ]}
    />
  );
}

test('Tabs use a roving tabindex, skip disabled tabs and show the selected panel', async () => {
  const user = userEvent.setup();
  render(<TabsHarness />);
  const tasks = screen.getByRole('tab', { name: 'Tasks' });
  expect(tasks.getAttribute('aria-selected')).toBe('true');
  expect(screen.getByRole('tab', { name: 'Computers 3' }).tabIndex).toBe(-1);
  expect(screen.getByRole('tabpanel', { name: 'Tasks' }).textContent).toBe('Task usage');
  await user.tab();
  expect(document.activeElement).toBe(tasks);
  await user.keyboard('{ArrowRight}');
  const computers = screen.getByRole('tab', { name: 'Computers 3' });
  expect(document.activeElement).toBe(computers);
  expect(computers.getAttribute('aria-selected')).toBe('true');
  expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(computers.id);
  await user.keyboard('{Home}');
  expect(document.activeElement).toBe(tasks);
});

test('Stepper clamps typed values and disables the button at a bound', () => {
  const onChange = mock((_value: number) => {});
  render(<Stepper label="Concurrent tasks" value={20} min={1} max={20} onChange={onChange} />);
  expect((screen.getByRole('button', { name: 'Increase Concurrent tasks' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Decrease Concurrent tasks' }));
  expect(onChange).toHaveBeenLastCalledWith(19);
  const input = screen.getByRole('spinbutton', { name: 'Concurrent tasks' }) as HTMLInputElement;
  fireEvent.change(input, { target: { value: '0' } });
  expect(onChange).toHaveBeenLastCalledWith(1);
});

function OtpHarness({ onComplete }: { onComplete(code: string): void }) {
  const [code, setCode] = useState('');
  return <OtpInput label="Verification code" value={code} onChange={setCode} onComplete={onComplete} />;
}

test('OtpInput moves forward while typing, back on Backspace and completes the code', async () => {
  const user = userEvent.setup();
  const onComplete = mock((_code: string) => {});
  render(<OtpHarness onComplete={onComplete} />);
  const cells = screen.getAllByRole('textbox') as HTMLInputElement[];
  expect(cells).toHaveLength(6);
  await user.click(cells[0]!);
  await user.keyboard('12a3');
  expect(cells.map(c => c.value).join('')).toBe('123');
  expect(document.activeElement).toBe(cells[3]!);
  await user.keyboard('{Backspace}');
  expect(cells.map(c => c.value).join('')).toBe('12');
  expect(document.activeElement).toBe(cells[2]!);
  await user.keyboard('3456');
  expect(onComplete).toHaveBeenCalledWith('123456');
});

test('OtpInput accepts a pasted code', async () => {
  const user = userEvent.setup();
  const onComplete = mock((_code: string) => {});
  render(<OtpHarness onComplete={onComplete} />);
  await user.click(screen.getByRole('textbox', { name: 'Digit 1 of 6' }));
  await user.paste('98-76-54');
  expect(onComplete).toHaveBeenCalledWith('987654');
});

function TagHarness() {
  const [values, setValues] = useState(['team@acme.com']);
  return <TagInput label="Approved senders" values={values} onChange={setValues} validate={v => v.includes('@')} />;
}

test('TagInput adds on Enter, rejects invalid and duplicate values, removes with Backspace', async () => {
  const user = userEvent.setup();
  render(<TagHarness />);
  const input = screen.getByRole('textbox', { name: 'Approved senders' });
  await user.type(input, 'ops@acme.com{Enter}not-an-email{Enter}');
  expect(screen.getAllByRole('button', { name: /^Remove / }).map(b => b.getAttribute('aria-label'))).toEqual([
    'Remove team@acme.com',
    'Remove ops@acme.com',
  ]);
  await user.clear(input);
  await user.type(input, 'team@acme.com{Enter}');
  expect(screen.getAllByRole('button', { name: /^Remove / })).toHaveLength(2);
  await user.clear(input);
  await user.keyboard('{Backspace}');
  expect(screen.queryByRole('button', { name: 'Remove ops@acme.com' })).toBeNull();
});

// fireEvent.drag*/drop в happy-dom создаёт событие, которое не доходит до слушателей: шлём Event сами.
function drag(target: Element, type: string, files: File[] = []) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files } });
  act(() => {
    target.dispatchEvent(event);
  });
}

test('Dropzone highlights while dragging and hands over dropped files', () => {
  const onFiles = mock((_files: File[]) => {});
  render(<Dropzone onFiles={onFiles} hint="CSV, XLSX, PDF · up to 50 MB" />);
  const zone = screen.getByText('browse').closest('label')!;
  drag(zone, 'dragenter');
  expect(zone.className).toBe('ui-dropzone is-dragover');
  const file = new File(['a,b'], 'data.csv', { type: 'text/csv' });
  drag(zone, 'drop', [file]);
  expect(zone.className).toBe('ui-dropzone');
  expect(onFiles).toHaveBeenCalledWith([file]);
});

function ShortcutHarness() {
  const [keys, setKeys] = useState<string[]>(['⌘', 'O']);
  return <ShortcutInput label="New task" value={keys} onChange={setKeys} />;
}

test('ShortcutInput records the next combination and can be cleared', async () => {
  const user = userEvent.setup();
  render(<ShortcutHarness />);
  const keys = screen.getByRole('button', { name: 'New task: ⌘ O' });
  await user.click(keys);
  expect(keys.getAttribute('aria-pressed')).toBe('true');
  await user.keyboard('{Meta>}{Shift>}k{/Shift}{/Meta}');
  expect(keys.getAttribute('aria-pressed')).toBe('false');
  expect(keys.getAttribute('aria-label')).toBe('New task: ⌘ ⇧ K');
  await user.click(keys);
  await user.keyboard('{Escape}');
  expect(keys.getAttribute('aria-label')).toBe('New task: ⌘ ⇧ K');
  await user.click(screen.getByRole('button', { name: 'Clear New task' }));
  expect(keys.getAttribute('aria-label')).toBe('New task: Not set');
});

test('nextIndex returns null for an empty list', () => {
  expect(nextIndex('ArrowRight', 0, 0, none, 'horizontal')).toBeNull();
  expect(nextIndex('Home', 0, 0, none, 'horizontal')).toBeNull();
  expect(nextIndex('End', 0, 0, none, 'horizontal')).toBeNull();
});

test('Tabs wrap backwards with ArrowLeft and link every tab to its panel', async () => {
  const user = userEvent.setup();
  render(<TabsHarness />);
  const tasks = screen.getByRole('tab', { name: 'Tasks' });
  await user.tab();
  await user.keyboard('{ArrowLeft}');
  const computers = screen.getByRole('tab', { name: 'Computers 3' });
  expect(document.activeElement).toBe(computers);
  const panel = screen.getByRole('tabpanel');
  expect(computers.getAttribute('aria-controls')).toBe(panel.id);
  expect(panel.getAttribute('aria-labelledby')).toBe(computers.id);
  expect(tasks.getAttribute('aria-selected')).toBe('false');
});

test('Tabs keep one tab in the tab order when the value points at a disabled tab', () => {
  render(
    <Tabs
      label="Usage"
      value="websites"
      onChange={() => {}}
      items={[
        { value: 'tasks', label: 'Tasks' },
        { value: 'websites', label: 'Websites', disabled: true },
      ]}
    />,
  );
  expect(screen.getByRole('tab', { name: 'Tasks' }).tabIndex).toBe(0);
  expect(screen.getByRole('tab', { name: 'Websites' }).tabIndex).toBe(-1);
});

test('Tabs leave arrow keys with modifiers to the browser', () => {
  const onChange = mock((_value: 'a' | 'b') => {});
  render(
    <Tabs
      label="Usage"
      value="a"
      onChange={onChange}
      items={[
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ]}
    />,
  );
  const notPrevented = fireEvent.keyDown(screen.getByRole('tab', { name: 'A' }), { key: 'ArrowRight', altKey: true });
  expect(notPrevented).toBe(true);
  expect(onChange).not.toHaveBeenCalled();
});

test('Stepper increases up to the max and then disables the button', () => {
  const onChange = mock((_value: number) => {});
  render(<Stepper label="Tasks" value={19} min={1} max={20} onChange={onChange} />);
  fireEvent.click(screen.getByRole('button', { name: 'Increase Tasks' }));
  expect(onChange).toHaveBeenLastCalledWith(20);
});

test('OtpInput cells are numeric and only the first offers one-time-code autofill', () => {
  render(<OtpHarness onComplete={() => {}} />);
  const cells = screen.getAllByRole('textbox') as HTMLInputElement[];
  expect(cells.every(c => c.getAttribute('inputmode') === 'numeric')).toBe(true);
  expect(cells[0]!.getAttribute('autocomplete')).toBe('one-time-code');
  expect(cells[1]!.getAttribute('autocomplete')).toBe('off');
});

test('OtpInput does not complete again when a paste leaves the code unchanged', async () => {
  const user = userEvent.setup();
  const onComplete = mock((_code: string) => {});
  render(<OtpHarness onComplete={onComplete} />);
  await user.click(screen.getByRole('textbox', { name: 'Digit 1 of 6' }));
  await user.paste('123456');
  expect(onComplete).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('textbox', { name: 'Digit 1 of 6' }));
  await user.paste('123456');
  expect(onComplete).toHaveBeenCalledTimes(1);
});

test('TagInput adds on comma, ignores keys during IME composition and refocuses the input after removal', async () => {
  const user = userEvent.setup();
  render(<TagHarness />);
  const input = screen.getByRole('textbox', { name: 'Approved senders' });
  await user.type(input, 'a@acme.com,');
  expect(screen.getByRole('button', { name: 'Remove a@acme.com' })).toBeTruthy();
  await user.type(input, 'b@acme.com');
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
  expect(screen.queryByRole('button', { name: 'Remove b@acme.com' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Remove a@acme.com' }));
  expect(screen.queryByRole('button', { name: 'Remove a@acme.com' })).toBeNull();
  expect(document.activeElement).toBe(input);
});

test('Dropzone filters dropped files by accept and keeps only the first when not multiple', () => {
  const onFiles = mock((_files: File[]) => {});
  const csv = new File(['a'], 'Data.CSV', { type: '' });
  const png = new File(['b'], 'pic.png', { type: 'image/png' });
  const jpg = new File(['c'], 'pic.jpg', { type: 'image/jpeg' });
  const pdf = new File(['d'], 'doc.pdf', { type: 'application/pdf' });
  const { unmount } = render(<Dropzone onFiles={onFiles} accept=".csv, image/*" />);
  drag(screen.getByText('browse').closest('label')!, 'drop', [csv, png, jpg, pdf]);
  expect(onFiles).toHaveBeenLastCalledWith([csv, png, jpg]);
  unmount();
  render(<Dropzone onFiles={onFiles} accept="application/pdf" multiple={false} />);
  drag(screen.getByText('browse').closest('label')!, 'drop', [png, pdf, pdf]);
  expect(onFiles).toHaveBeenLastCalledWith([pdf]);
  onFiles.mockClear();
  drag(screen.getByText('browse').closest('label')!, 'drop', [png]);
  expect(onFiles).not.toHaveBeenCalled();
});

test('Dropzone ignores a leave into its own children and swallows drops while disabled', () => {
  const onFiles = mock((_files: File[]) => {});
  const { rerender } = render(<Dropzone onFiles={onFiles} />);
  const zone = screen.getByText('browse').closest('label')!;
  drag(zone, 'dragenter');
  const leave = new Event('dragleave', { bubbles: true, cancelable: true });
  Object.defineProperty(leave, 'relatedTarget', { value: screen.getByText('browse') });
  act(() => {
    zone.dispatchEvent(leave);
  });
  expect(zone.className).toBe('ui-dropzone is-dragover');
  rerender(<Dropzone onFiles={onFiles} disabled />);
  expect(zone.className).toBe('ui-dropzone');
  const drop = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(drop, 'dataTransfer', { value: { files: [new File(['a'], 'a.txt')] } });
  act(() => {
    zone.dispatchEvent(drop);
  });
  expect(drop.defaultPrevented).toBe(true);
  expect(onFiles).not.toHaveBeenCalled();
});

const press = (init: KeyboardEventInit) => shortcutFromEvent(new KeyboardEvent('keydown', init));

test('shortcutFromEvent reads the physical key so Option and Shift do not change the letter', () => {
  const key = press;
  expect(key({ altKey: true, key: 'ø', code: 'KeyO' })).toEqual(['⌥', 'O']);
  expect(key({ shiftKey: true, key: '!', code: 'Digit1' })).toEqual(['⇧', '1']);
  expect(key({ key: 'Enter', code: 'Enter' })).toEqual(['↵']);
  expect(key({ key: 'F5', code: 'F5' })).toEqual(['F5']);
  expect(key({ key: 'Shift', code: 'ShiftLeft', shiftKey: true })).toBeNull();
});

test('ShortcutInput focuses its button when recording starts, keeps keys inside while recording and refocuses after clear', async () => {
  const user = userEvent.setup();
  const outside = mock((_key: string) => {});
  render(<ShortcutHarness />);
  document.body.addEventListener('keydown', event => outside(event.key));
  const keys = screen.getByRole('button', { name: 'New task: ⌘ O' });
  fireEvent.click(keys);
  expect(keys.getAttribute('aria-pressed')).toBe('true');
  expect(document.activeElement).toBe(keys);
  await user.keyboard('{Escape}');
  expect(outside).not.toHaveBeenCalled();
  await user.keyboard('{Escape}');
  expect(outside).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('button', { name: 'Clear New task' }));
  expect(document.activeElement).toBe(keys);
});
