import { expect, mock, test } from 'bun:test';
import { fireEvent, render, screen } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { createRef } from 'preact';
import { Moon, Search, Sun } from 'lucide-preact';
import {
  Checkbox,
  ChoiceGroup,
  Field,
  Input,
  NativeSelect,
  RadioGroup,
  SegmentedControl,
  Slider,
  Switch,
  Textarea,
} from '../src/index.ts';

test('Field labels its control and describes it with the hint', () => {
  render(
    <Field label="Occupation" hint="Used to personalize responses." optional>
      <Input placeholder="Product designer" />
    </Field>,
  );
  const input = screen.getByRole('textbox', { name: 'Occupation Optional' });
  expect(input.getAttribute('aria-invalid')).toBeNull();
  expect(document.getElementById(input.getAttribute('aria-describedby')!)?.textContent).toBe(
    'Used to personalize responses.',
  );
});

test('Field with an error marks the control invalid and points at the error instead of the hint', () => {
  render(
    <Field label="Email" hint="Work email" error="Enter a valid email address" counter="12 / 300">
      <Input value="not-an-email" aria-describedby="extra" />
    </Field>,
  );
  const input = screen.getByRole('textbox', { name: 'Email' });
  expect(input.getAttribute('aria-invalid')).toBe('true');
  const [own, message] = input.getAttribute('aria-describedby')!.split(' ');
  expect(own).toBe('extra');
  expect(document.getElementById(message!)?.className).toBe('ui-error');
  expect(screen.queryByText('Work email')).toBeNull();
  expect(screen.getByText('12 / 300').className).toBe('ui-counter');
});

test('Input with an icon, a key hint and an action renders an input group and forwards its ref', () => {
  const ref = createRef<HTMLInputElement>();
  render(<Input ref={ref} aria-label="Search" icon={Search} kbd="/" action={<button type="button">Go</button>} />);
  const input = screen.getByRole('textbox', { name: 'Search' });
  expect(input.parentElement?.className).toBe('ui-input-group');
  expect(input.previousElementSibling?.className).toBe('ui-input-group__icon');
  expect(ref.current).toBe(input as HTMLInputElement);
});

test('Textarea with autosize grows to its scroll height when the value changes', () => {
  const { rerender } = render(<Textarea aria-label="Notes" autosize value="" />);
  const textarea = screen.getByRole('textbox', { name: 'Notes' }) as HTMLTextAreaElement;
  Object.defineProperty(textarea, 'scrollHeight', { configurable: true, value: 132 });
  rerender(<Textarea aria-label="Notes" autosize value={'a\nb\nc'} />);
  expect(textarea.style.height).toBe('132px');
});

test('NativeSelect renders its options and takes the field id', () => {
  render(
    <Field label="Language">
      <NativeSelect
        options={[
          { value: 'en', label: 'English' },
          { value: 'de', label: 'Deutsch', disabled: true },
        ]}
      />
    </Field>,
  );
  const select = screen.getByRole('combobox', { name: 'Language' }) as HTMLSelectElement;
  expect([...select.options].map(o => [o.value, o.disabled])).toEqual([
    ['en', false],
    ['de', true],
  ]);
});

test('Checkbox reflects indeterminate on the native input', () => {
  render(<Checkbox label="Select all tasks" indeterminate />);
  const box = screen.getByRole('checkbox', { name: 'Select all tasks' }) as HTMLInputElement;
  expect(box.indeterminate).toBe(true);
});

test('Switch is a labelled switch that reports the new state', async () => {
  const user = userEvent.setup();
  const onCheckedChange = mock((_checked: boolean) => {});
  render(
    <>
      <Switch label="Product updates" checked={false} onCheckedChange={onCheckedChange} />
      <Switch label="Sound alert" hideLabel checked onCheckedChange={() => {}} size="sm" />
    </>,
  );
  await user.click(screen.getByRole('switch', { name: 'Product updates' }));
  expect(onCheckedChange).toHaveBeenCalledWith(true);
  const hidden = screen.getByRole('switch', { name: 'Sound alert' });
  expect(hidden.className).toBe('ui-switch ui-switch--sm');
  expect(hidden.getAttribute('aria-checked')).toBe('true');
});

test('RadioGroup checks the current value and reports a new choice', async () => {
  const user = userEvent.setup();
  const onChange = mock((_value: string) => {});
  render(
    <RadioGroup
      label="While a task is running"
      name="busy"
      value="send"
      onChange={onChange}
      options={[
        { value: 'send', label: 'Send without interrupting' },
        { value: 'queue', label: 'Queue the message' },
      ]}
    />,
  );
  expect(screen.getByRole('radiogroup', { name: 'While a task is running' })).toBeTruthy();
  expect((screen.getByRole('radio', { name: 'Send without interrupting' }) as HTMLInputElement).checked).toBe(true);
  await user.click(screen.getByRole('radio', { name: 'Queue the message' }));
  expect(onChange).toHaveBeenCalledWith('queue');
});

test('Slider fills the track up to the value and reports numbers', () => {
  const onValueChange = mock((_value: number) => {});
  render(
    <Slider
      aria-label="Monthly credit cap"
      min={1000}
      max={12000}
      step={500}
      value={6500}
      onValueChange={onValueChange}
      formatValue={v => `${v.toLocaleString('en-US')} credits`}
    />,
  );
  const slider = screen.getByRole('slider', { name: 'Monthly credit cap' }) as HTMLInputElement;
  expect(slider.style.getPropertyValue('--val')).toBe('50%');
  expect(slider.getAttribute('aria-valuetext')).toBe('6,500 credits');
  fireEvent.input(slider, { target: { value: '7000' } });
  expect(onValueChange).toHaveBeenCalledWith(7000);
});

test('SegmentedControl presses the current segment; icon-only segments are labelled', async () => {
  const user = userEvent.setup();
  const onChange = mock((_value: string) => {});
  render(
    <SegmentedControl
      label="Theme"
      value="dark"
      onChange={onChange}
      options={[
        { value: 'light', icon: Sun, ariaLabel: 'Light theme' },
        { value: 'dark', icon: Moon, ariaLabel: 'Dark theme' },
      ]}
    />,
  );
  expect(screen.getByRole('button', { name: 'Dark theme' }).getAttribute('aria-pressed')).toBe('true');
  await user.click(screen.getByRole('button', { name: 'Light theme' }));
  expect(onChange).toHaveBeenCalledWith('light');
});

test('ChoiceGroup is a radiogroup of cards', async () => {
  const user = userEvent.setup();
  const onChange = mock((_value: string) => {});
  render(
    <ChoiceGroup
      label="Theme"
      name="theme"
      value="dark"
      onChange={onChange}
      options={[
        { value: 'light', label: 'Light', icon: Sun },
        { value: 'dark', label: 'Dark', icon: Moon },
      ]}
    />,
  );
  expect((screen.getByRole('radio', { name: 'Dark' }) as HTMLInputElement).checked).toBe(true);
  await user.click(screen.getByText('Light'));
  expect(onChange).toHaveBeenCalledWith('light');
});

test('Field follows an explicit control id: label, hint and describedby agree', () => {
  render(
    <Field label="Handle" hint="Public name">
      <Input id="foo" />
    </Field>,
  );
  const input = screen.getByRole('textbox', { name: 'Handle' });
  expect(input.id).toBe('foo');
  expect(screen.getByText('Handle').getAttribute('for')).toBe('foo');
  expect(document.getElementById(input.getAttribute('aria-describedby')!)?.textContent).toBe('Public name');
});

test('two Fields get unique ids', () => {
  render(
    <>
      <Field label="First">
        <Input />
      </Field>
      <Field label="Second" hint="Hint">
        <Input />
      </Field>
    </>,
  );
  const first = screen.getByRole('textbox', { name: 'First' });
  const second = screen.getByRole('textbox', { name: 'Second' });
  expect(first.id).not.toBe(second.id);
  expect(first.id).toBeTruthy();
});

test('a consumer aria-invalid and aria-describedby survive outside a Field error', () => {
  render(<Input aria-label="Name" aria-invalid="grammar" aria-describedby="note" />);
  const input = screen.getByRole('textbox', { name: 'Name' });
  expect(input.getAttribute('aria-invalid')).toBe('grammar');
  expect(input.getAttribute('aria-describedby')).toBe('note');
});

test('Field error is announced with role alert', () => {
  render(
    <Field label="Email" error="Enter a valid email address">
      <Input />
    </Field>,
  );
  expect(screen.getByRole('alert').textContent).toBe('Enter a valid email address');
});

test('uncontrolled Textarea with autosize grows while typing', () => {
  render(<Textarea aria-label="Notes" autosize />);
  const textarea = screen.getByRole('textbox', { name: 'Notes' }) as HTMLTextAreaElement;
  Object.defineProperty(textarea, 'scrollHeight', { configurable: true, value: 96 });
  const onInput = mock((_event: Event) => {});
  render(<Textarea aria-label="Other" autosize onInput={onInput} />);
  fireEvent.input(textarea, { target: { value: 'a\nb' } });
  expect(textarea.style.height).toBe('96px');
  const other = screen.getByRole('textbox', { name: 'Other' });
  fireEvent.input(other, { target: { value: 'x' } });
  expect(onInput).toHaveBeenCalledTimes(1);
});

test('Checkbox and Switch take the Field label, invalid state and description', () => {
  render(
    <>
      <Field label="Accept terms" error="Required">
        <Checkbox label="I agree" />
      </Field>
      <Field label="Notifications" hint="Sent by email">
        <Switch label="Enabled" checked={false} onCheckedChange={() => {}} />
      </Field>
    </>,
  );
  const box = screen.getByRole('checkbox');
  expect(box.getAttribute('aria-invalid')).toBe('true');
  expect(document.getElementById(box.getAttribute('aria-describedby')!)?.textContent).toBe('Required');
  const sw = screen.getByRole('switch');
  expect(sw.id).toBeTruthy();
  expect(document.getElementById(sw.getAttribute('aria-describedby')!)?.textContent).toBe('Sent by email');
});

test('Checkbox keeps indeterminate in sync with the prop on every render', () => {
  const { rerender } = render(<Checkbox label="All" indeterminate />);
  const box = screen.getByRole('checkbox') as HTMLInputElement;
  box.indeterminate = false;
  rerender(<Checkbox label="All" indeterminate />);
  expect(box.indeterminate).toBe(true);
  rerender(<Checkbox label="All" />);
  expect(box.indeterminate).toBe(false);
});

test('Switch is off with aria-checked false and toggles with Space', async () => {
  const user = userEvent.setup();
  const onCheckedChange = mock((_checked: boolean) => {});
  render(<Switch label="Beta" checked={false} onCheckedChange={onCheckedChange} />);
  const sw = screen.getByRole('switch', { name: 'Beta' });
  expect(sw.getAttribute('aria-checked')).toBe('false');
  sw.focus();
  await user.keyboard(' ');
  expect(onCheckedChange).toHaveBeenCalledWith(true);
});

test('RadioGroup shares one name and honours disabled options', async () => {
  const user = userEvent.setup();
  const onChange = mock((_value: string) => {});
  render(
    <RadioGroup
      label="Plan"
      name="plan"
      value="free"
      onChange={onChange}
      options={[
        { value: 'free', label: 'Free' },
        { value: 'pro', label: 'Pro', disabled: true },
      ]}
    />,
  );
  const radios = screen.getAllByRole('radio') as HTMLInputElement[];
  expect(radios.map(r => r.name)).toEqual(['plan', 'plan']);
  expect(radios[1]!.disabled).toBe(true);
  await user.click(radios[1]!);
  expect(onChange).not.toHaveBeenCalled();
});

test('Slider merges the consumer style and clamps the fill to 0-100%', () => {
  const { rerender } = render(
    <Slider aria-label="Volume" value={150} min={0} max={100} style={{ width: '200px' }} onValueChange={() => {}} />,
  );
  const slider = screen.getByRole('slider', { name: 'Volume' }) as HTMLInputElement;
  expect(slider.style.getPropertyValue('--val')).toBe('100%');
  expect(slider.style.width).toBe('200px');
  rerender(<Slider aria-label="Volume" value={-10} style={{ width: '200px' }} onValueChange={() => {}} />);
  expect(slider.style.getPropertyValue('--val')).toBe('0%');
});

test('SegmentedControl marks non-selected segments aria-pressed false', () => {
  render(
    <SegmentedControl
      label="View"
      value="a"
      onChange={() => {}}
      options={[
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ]}
    />,
  );
  expect(screen.getByRole('button', { name: 'A' }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByRole('button', { name: 'B' }).getAttribute('aria-pressed')).toBe('false');
});
