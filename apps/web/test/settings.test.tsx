import { expect, test } from 'bun:test';
import { screen, within } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { SettingsPage } from '../src/routes/settings.tsx';
import { json, me, noContent, taskSummary } from './fixtures.ts';
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

test('the sections come in order: Profile, Appearance, Credits, Usage, Account', async () => {
  const { view, state } = setup(signedIn(), '/settings');
  await state.session.load();
  view(<SettingsPage />);
  expect(screen.getAllByRole('heading', { level: 2 }).map(h => h.textContent)).toEqual([
    'Profile',
    'Appearance',
    'Credits',
    'Usage',
    'Account',
  ]);
  expect(screen.getByRole('img', { name: 'Ada' })).toBeTruthy();
});

test('the name is saved trimmed and shown; Save is off while nothing changed', async () => {
  const { view, calls, state } = setup(
    { ...signedIn(), 'PATCH /api/me': json(me({ name: 'Ada Lovelace' })) },
    '/settings',
  );
  await state.session.load();
  view(<SettingsPage />);
  const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  const field = screen.getByRole('textbox', { name: 'Name' });
  await userEvent.clear(field);
  expect(save.disabled).toBe(true);
  await userEvent.type(field, '  Ada Lovelace ');
  await userEvent.click(save);
  await screen.findByText('Name saved');
  expect(calls.find(c => c.method === 'PATCH')?.body).toEqual({ name: 'Ada Lovelace' });
  expect(state.session.me.value?.user.name).toBe('Ada Lovelace');
  expect(screen.getByRole('img', { name: 'Ada Lovelace' })).toBeTruthy();
  expect(save.disabled).toBe(true);
});

test('a refused name is shown and the profile keeps the old one', async () => {
  const { view, state } = setup(
    { ...signedIn(), 'PATCH /api/me': json({ error: { code: 'bad_request', message: 'name is too long' } }, 400) },
    '/settings',
  );
  await state.session.load();
  view(<SettingsPage />);
  await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), ' B');
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText('Could not save the name');
  expect(state.session.me.value?.user.name).toBe('Ada');
});

test('usage lists tasks with links and credits; events of deleted tasks are one row', async () => {
  const usage = [
    {
      taskId: 't1',
      prompt: 'Find suppliers\nin the EU',
      millicredits: 1500,
      credits: '1.5',
      tokens: 12_000,
      lastActivityAt: '2026-11-02T10:00:00.000Z',
    },
    {
      taskId: null,
      prompt: null,
      millicredits: 250,
      credits: '0.25',
      tokens: 90,
      lastActivityAt: '2026-11-01T10:00:00.000Z',
    },
  ];
  const { view, state } = setup({ ...signedIn(), 'GET /api/usage': json({ usage }) }, '/settings');
  await state.session.load();
  view(<SettingsPage />);
  const link = await screen.findByRole('link', { name: 'Find suppliers' });
  expect(link.getAttribute('href')).toBe('/tasks/t1');
  expect(screen.getByText('1.5 credits')).toBeTruthy();
  expect(screen.getByText(/^12,000 tokens · Nov 2, 2026$/)).toBeTruthy();
  expect(screen.getByText('Deleted tasks')).toBeTruthy();
  expect(screen.getByText('0.25 credits')).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'Deleted tasks' })).toBeNull();
});

test('an empty history and a failed load say so', async () => {
  const empty = setup(signedIn(), '/settings');
  await empty.state.session.load();
  const { unmount } = empty.view(<SettingsPage />);
  await screen.findByText('No credits spent yet.');
  unmount();

  const broken = setup(
    { ...signedIn(), 'GET /api/usage': json({ error: { code: 'internal', message: 'boom' } }, 500) },
    '/settings',
  );
  await broken.state.session.load();
  broken.view(<SettingsPage />);
  await screen.findByText('Could not load the usage history.');
});

async function openDeleteDialog(routes: Parameters<typeof setup>[0]) {
  const env = setup({ ...signedIn(), ...routes }, '/settings');
  await env.state.session.load();
  await env.state.tasks.reload();
  env.view(<SettingsPage />);
  await userEvent.click(screen.getByRole('button', { name: 'Delete account' }));
  const dialog = await screen.findByRole('alertdialog', { name: 'Delete your account?' });
  return {
    ...env,
    dialog,
    field: within(dialog).getByRole('textbox', { name: 'Type your email to confirm' }),
    confirm: within(dialog).getByRole('button', { name: 'Delete account' }) as HTMLButtonElement,
  };
}

test('deleting the account needs the email typed; success ends the session and forgets the tasks', async () => {
  const { field, confirm, calls, state } = await openDeleteDialog({
    'GET /api/tasks': json({ tasks: [taskSummary()], nextCursor: null }),
    'DELETE /api/me': noContent,
  });
  expect(confirm.disabled).toBe(true);
  await userEvent.type(field, 'someone@else.dev');
  expect(confirm.disabled).toBe(true);
  await userEvent.clear(field);
  await userEvent.type(field, 'ADA@example.com');
  expect(confirm.disabled).toBe(false);
  await userEvent.click(confirm);
  await until(() => state.session.status.value === 'signed_out');
  expect(calls.find(c => c.method === 'DELETE')).toMatchObject({
    path: '/api/me',
    body: { email: 'ADA@example.com' },
  });
  expect(state.session.leftOnPurpose.value).toBe(true);
  expect(state.tasks.items.value).toEqual([]);
});

test('Enter in the email field submits; a refusal is shown in the dialog and the session stays', async () => {
  const { dialog, field, state } = await openDeleteDialog({
    'DELETE /api/me': json({ error: { code: 'conflict', message: 'you have running tasks' } }, 409),
  });
  await userEvent.type(field, 'ada@example.com{Enter}');
  await within(dialog).findByText('you have running tasks');
  expect(state.session.status.value).toBe('signed_in');
  expect(screen.getByRole('alertdialog')).toBeTruthy();
});

test('Cancel closes the dialog and deletes nothing', async () => {
  const { dialog, calls } = await openDeleteDialog({ 'DELETE /api/me': noContent });
  await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  await until(() => screen.queryByRole('alertdialog') === null);
  expect(calls.some(c => c.method === 'DELETE')).toBe(false);
});
