import { expect, test } from 'bun:test';
import { screen } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { SettingsPage } from '../src/routes/settings.tsx';
import { json, me } from './fixtures.ts';
import { setup, signedIn, until } from './render.tsx';

test('choosing a theme applies it at once and saves it in the profile', async () => {
  const { view, calls, state } = setup({ ...signedIn(), 'PATCH /api/me': json(me({ theme: 'light' })) }, '/settings');
  await state.session.load();
  expect(document.documentElement.dataset.theme).toBe('dark');
  view(<SettingsPage />);
  expect(document.title).toBe('Settings · agent');
  await userEvent.click(screen.getByRole('radio', { name: 'Light' }));
  expect(document.documentElement.dataset.theme).toBe('light');
  await until(() => calls.some(c => c.method === 'PATCH'));
  expect(calls.find(c => c.method === 'PATCH')?.body).toEqual({ theme: 'light' });
  await until(() => state.session.me.value?.user.theme === 'light');
  expect(localStorage.getItem('ui-theme')).toBe('light');
});

test('a failed save puts the previous theme back and says so', async () => {
  const { view, state } = setup(
    { ...signedIn(), 'PATCH /api/me': json({ error: { code: 'internal', message: 'internal error' } }, 500) },
    '/settings',
  );
  await state.session.load();
  view(<SettingsPage />);
  await userEvent.click(screen.getByRole('radio', { name: 'System' }));
  await screen.findByText('Could not save the theme');
  expect(document.documentElement.dataset.theme).toBe('dark');
});

test('the profile theme is applied on sign-in', async () => {
  const { state } = setup({ ...signedIn(), 'GET /api/me': json(me({ theme: 'auto' })) });
  await state.session.load();
  expect(document.documentElement.dataset.theme).toBe('auto');
});

test('credits and email are shown; Sign out ends the session', async () => {
  const { view, calls, state } = setup(
    { ...signedIn(), 'GET /api/me': json(me({}, 7_250)), 'POST /api/auth/sign-out': json({ success: true }) },
    '/settings',
  );
  await state.session.load();
  view(<SettingsPage />);
  expect(screen.getAllByText('7.25').length).toBeGreaterThan(0);
  expect(screen.getByText('ada@example.com')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  await until(() => state.session.status.value === 'signed_out');
  expect(calls.some(c => c.method === 'POST' && c.path === '/api/auth/sign-out')).toBe(true);
});

test('a failed sign-out keeps the session and says so', async () => {
  const { view, state } = setup(
    { ...signedIn(), 'POST /api/auth/sign-out': json({ message: 'boom' }, 500) },
    '/settings',
  );
  await state.session.load();
  view(<SettingsPage />);
  await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  await screen.findByText('Could not sign out');
  expect(state.session.status.value).toBe('signed_in');
  expect((screen.getByRole('button', { name: 'Sign out' }) as HTMLButtonElement).disabled).toBe(false);
});
