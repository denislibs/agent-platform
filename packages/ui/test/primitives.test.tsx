import { expect, mock, test } from 'bun:test';
import { fireEvent, render, screen } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { Copy } from 'lucide-preact';
import { Alert, Avatar, AvatarGroup, Badge, Button, Chip, IconButton, initials, Progress, Tag } from '../src/index.ts';

test('Button maps variant and size to ui-btn classes and defaults to type="button"', () => {
  const submit = mock((e: Event) => e.preventDefault());
  render(
    <form onSubmit={submit}>
      <Button variant="primary" size="sm" block>
        Save
      </Button>
    </form>,
  );
  const button = screen.getByRole('button', { name: 'Save' });
  expect(button.className).toBe('ui-btn ui-btn--primary ui-btn--sm ui-btn--block');
  fireEvent.click(button);
  expect(submit).not.toHaveBeenCalled();
});

test('a loading Button is aria-busy and ignores clicks and Enter', async () => {
  const user = userEvent.setup();
  const onClick = mock(() => {});
  render(
    <Button loading onClick={onClick}>
      Save
    </Button>,
  );
  const button = screen.getByRole('button', { name: 'Save' });
  expect(button.getAttribute('aria-busy')).toBe('true');
  button.focus();
  await user.keyboard('{Enter}');
  fireEvent.click(button);
  expect(onClick).not.toHaveBeenCalled();
});

test('IconButton is named by its label and renders a decorative icon', () => {
  render(<IconButton icon={Copy} label="Copy" />);
  const button = screen.getByRole('button', { name: 'Copy' });
  expect(button.className).toBe('ui-btn ui-btn--ghost ui-btn--sm ui-btn--icon');
  expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
});

test('Badge combines tone, variant and shape modifiers', () => {
  render(
    <>
      <Badge tone="success">Done</Badge>
      <Badge variant="solid" pill count>
        12
      </Badge>
      <Badge tone="danger" variant="outline">
        Lite
      </Badge>
    </>,
  );
  expect(screen.getByText('Done').className).toBe('ui-badge ui-badge--success');
  expect(screen.getByText('12').className).toBe('ui-badge ui-badge--solid ui-badge--pill ui-badge--count');
  expect(screen.getByText('Lite').className).toBe('ui-badge ui-badge--outline');
});

test('initials take the first letters of two words', () => {
  expect(initials('Ada Lovelace King')).toBe('AL');
  expect(initials('  denis ')).toBe('D');
  expect(initials('')).toBe('?');
});

test('Avatar is an image named after the person; AvatarGroup collapses the rest into +N', () => {
  render(
    <>
      <Avatar name="Ada Lovelace" online />
      <AvatarGroup
        label="Members"
        people={[{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }, { name: 'E' }]}
      />
    </>,
  );
  expect(screen.getByRole('img', { name: 'Ada Lovelace' }).textContent).toBe('AL');
  const group = screen.getByRole('group', { name: 'Members' });
  expect(group.querySelectorAll('.ui-avatar')).toHaveLength(4);
  expect(screen.getByRole('img', { name: '2 more' }).textContent).toBe('+2');
});

test('Progress exposes a clamped value and drives --val', () => {
  render(
    <>
      <Progress label="Upload" value={140} />
      <Progress label="Credits" value={3} max={4} tone="warning" size="sm" />
      <Progress label="Loading" indeterminate />
    </>,
  );
  const upload = screen.getByRole('progressbar', { name: 'Upload' });
  expect(upload.getAttribute('aria-valuenow')).toBe('100');
  expect(upload.style.getPropertyValue('--val')).toBe('100%');
  const credits = screen.getByRole('progressbar', { name: 'Credits' });
  expect(credits.className).toBe('ui-progress ui-progress--sm ui-progress--warning');
  expect(credits.style.getPropertyValue('--val')).toBe('75%');
  expect(screen.getByRole('progressbar', { name: 'Loading' }).hasAttribute('aria-valuenow')).toBe(false);
});

test('Chip toggles aria-pressed through onPressedChange', () => {
  const onPressedChange = mock((_pressed: boolean) => {});
  render(
    <Chip pressed={false} onPressedChange={onPressedChange}>
      Research
    </Chip>,
  );
  const chip = screen.getByRole('button', { name: 'Research' });
  expect(chip.getAttribute('aria-pressed')).toBe('false');
  fireEvent.click(chip);
  expect(onPressedChange).toHaveBeenCalledWith(true);
});

test('Tag has a labelled remove button only when removable', () => {
  const onRemove = mock(() => {});
  render(
    <>
      <Tag label="python" onRemove={onRemove} />
      <Tag label="csv" />
    </>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Remove python' }));
  expect(onRemove).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', { name: 'Remove csv' })).toBeNull();
});

test('Alert is announced only when live: danger as alert, info as status', () => {
  render(
    <>
      <Alert tone="danger" title="Sandbox failed to start" live>
        Try again in a minute.
      </Alert>
      <Alert tone="info" title="Working" live />
      <Alert tone="success" title="Static" />
    </>,
  );
  expect(screen.getByRole('alert').textContent).toContain('Sandbox failed to start');
  expect(screen.getByRole('status').textContent).toContain('Working');
  expect(screen.getByText('Static').closest('.ui-alert')?.hasAttribute('role')).toBe(false);
});
