import { expect, test } from 'bun:test';
import { fireEvent, render, screen } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { useState } from 'preact/hooks';
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

function Controls() {
  const toast = useToast();
  const [id, setId] = useState('');
  return (
    <>
      <button type="button" onClick={() => setId(toast.show({ tone: 'info', title: 'Twice' }))}>
        Show
      </button>
      <button
        type="button"
        onClick={() => {
          toast.dismiss(id);
          toast.dismiss(id);
          toast.dismiss('ui-toast-missing');
        }}
      >
        Dismiss thrice
      </button>
    </>
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

test('unmounting the provider with a pending timer causes no later state update', async () => {
  const user = userEvent.setup();
  const { unmount } = render(
    <ToastProvider duration={20} exitMs={0}>
      <Trigger tone="info" title="Soon gone" />
    </ToastProvider>,
  );
  await user.click(screen.getByRole('button', { name: 'Notify' }));
  const errors: unknown[] = [];
  const onError = (e: unknown) => errors.push(e);
  process.on('uncaughtException', onError);
  unmount();
  await new Promise(resolve => setTimeout(resolve, 60));
  process.off('uncaughtException', onError);
  expect(errors).toHaveLength(0);
  expect(document.body.querySelector('.ui-toast')).toBeNull();
});

test('dismiss ignores missing and already closing toasts instead of arming extra timers', async () => {
  const user = userEvent.setup();
  render(
    <ToastProvider duration={Infinity} exitMs={10}>
      <Controls />
    </ToastProvider>,
  );
  await user.click(screen.getByRole('button', { name: 'Show' }));
  await screen.findByRole('status');
  const original = globalThis.setTimeout;
  let armed = 0;
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    armed += 1;
    return original(...args);
  }) as typeof setTimeout;
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss thrice' }));
  } finally {
    globalThis.setTimeout = original;
  }
  expect(armed).toBe(1);
  await gone(() => screen.queryByRole('status'));
});
