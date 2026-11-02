import { expect, mock, test } from 'bun:test';
import { act, fireEvent, render, screen } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { useState } from 'preact/hooks';
import { Dropzone, nextIndex, OtpInput, ShortcutInput, Stepper, TagInput, Tabs } from '../src/index.ts';

const none = () => false;

test('nextIndex wraps around, honours Home/End and skips disabled items', () => {
  expect(nextIndex('ArrowRight', 2, 3, none, 'horizontal')).toBe(0);
  expect(nextIndex('ArrowLeft', 0, 3, none, 'horizontal')).toBe(2);
  expect(nextIndex('ArrowDown', 0, 3, i => i === 1, 'vertical')).toBe(2);
  expect(nextIndex('End', 0, 3, i => i === 2, 'vertical')).toBe(1);
  expect(nextIndex('Home', 2, 3, none, 'vertical')).toBe(0);
  expect(nextIndex('ArrowDown', 0, 3, none, 'horizontal')).toBeNull();
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
