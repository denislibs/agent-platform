import { expect, test } from 'bun:test';
import { render, screen } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { ToastProvider, useToast, type ToastOptions } from '../src/index.ts';
import { gone } from './helpers.ts';

function Trigger(props: ToastOptions) {
  const toast = useToast();
  return (
    <button type="button" onClick={() => toast.show(props)}>
      Notify
    </button>
  );
}

test('a toast appears in the live region and closes with Dismiss', async () => {
  const user = userEvent.setup();
  render(
    <ToastProvider duration={Infinity} exitMs={10}>
      <Trigger tone="success" title="Task completed" description="3 files saved." />
    </ToastProvider>,
  );
  await user.click(screen.getByRole('button', { name: 'Notify' }));
  const region = screen.getByRole('region', { name: 'Notifications' });
  expect(region.getAttribute('aria-live')).toBe('polite');
  const toast = screen.getByRole('status');
  expect(toast.textContent).toContain('Task completed');
  expect(toast.textContent).toContain('3 files saved.');
  await user.click(screen.getByRole('button', { name: 'Dismiss' }));
  expect(toast.dataset.state).toBe('closed');
  await gone(() => screen.queryByRole('status'));
});

test('toasts close by themselves after their duration; errors are alerts', async () => {
  const user = userEvent.setup();
  render(
    <ToastProvider duration={30} exitMs={0}>
      <Trigger tone="danger" title="Couldn't start sandbox" />
    </ToastProvider>,
  );
  await user.click(screen.getByRole('button', { name: 'Notify' }));
  expect(screen.getByRole('alert').textContent).toContain("Couldn't start sandbox");
  await gone(() => screen.queryByRole('alert'));
});

test('useToast outside a ToastProvider fails loudly', () => {
  expect(() => render(<Trigger tone="info" title="x" />)).toThrow('ToastProvider');
});
