import { expect, test } from 'bun:test';
import { screen, within } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { Route, Router } from 'preact-iso';
import { Shell } from '../src/layout/shell.tsx';
import { json, noContent, taskSummary } from './fixtures.ts';
import { setup, signedIn, until } from './render.tsx';

const Home = () => (
  <Shell>
    <h1 class="ui-h1">Home</h1>
  </Shell>
);
const app = (
  <Router>
    <Route path="/" component={Home} />
    <Route path="/tasks/:id" component={Home} />
  </Router>
);

const listed = (...tasks: Array<Parameters<typeof taskSummary>[0]>) =>
  json({ tasks: tasks.map(t => taskSummary(t)), nextCursor: null });

test('deleting the open task asks first, removes it from the sidebar and goes home', async () => {
  const { view, calls } = setup(
    {
      ...signedIn(),
      'GET /api/tasks': listed({ id: 't1', status: 'done', prompt: 'Old report' }, { id: 't2', prompt: 'Other' }),
      'DELETE /api/tasks/t1': noContent,
    },
    '/tasks/t1',
  );
  view(app);
  await userEvent.click(await screen.findByRole('button', { name: 'Delete task Old report' }));
  const dialog = await screen.findByRole('alertdialog', { name: 'Delete this task?' });
  expect(calls.some(c => c.method === 'DELETE')).toBe(false);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
  await until(() => location.pathname === '/');
  expect(calls.filter(c => c.method === 'DELETE').map(c => c.path)).toEqual(['/api/tasks/t1']);
  await until(() => screen.queryByRole('link', { name: /Old report/ }) === null);
  expect(screen.getByRole('link', { name: /Other/ })).toBeTruthy();
});

test('deleting another task keeps the open one on screen', async () => {
  const { view } = setup(
    {
      ...signedIn(),
      'GET /api/tasks': listed({ id: 't1', status: 'done', prompt: 'Old report' }, { id: 't2', prompt: 'Other' }),
      'DELETE /api/tasks/t1': noContent,
    },
    '/tasks/t2',
  );
  view(app);
  await userEvent.click(await screen.findByRole('button', { name: 'Delete task Old report' }));
  await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
  await until(() => screen.queryByRole('link', { name: /Old report/ }) === null);
  expect(location.pathname).toBe('/tasks/t2');
});

test('Cancel deletes nothing; a refusal of the API is shown and the task stays', async () => {
  const { view, calls } = setup(
    {
      ...signedIn(),
      'GET /api/tasks': listed({ id: 't1', prompt: 'Running one' }),
      'DELETE /api/tasks/t1': json(
        { error: { code: 'conflict', message: 'the task is still running; stop it first' } },
        409,
      ),
    },
    '/tasks/t1',
  );
  view(app);
  const action = await screen.findByRole('button', { name: 'Delete task Running one' });
  await userEvent.click(action);
  await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
  await until(() => screen.queryByRole('alertdialog') === null);
  expect(calls.some(c => c.method === 'DELETE')).toBe(false);

  await userEvent.click(action);
  await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
  await screen.findByText('Could not delete the task');
  screen.getByText('the task is still running; stop it first');
  expect(screen.getByRole('link', { name: /Running one/ })).toBeTruthy();
  expect(location.pathname).toBe('/tasks/t1');
});

test('the search field asks the API after typing, says when nothing matches, and clearing restores the list', async () => {
  const { view, calls } = setup({
    ...signedIn(),
    'GET /api/tasks?limit=20': listed({ id: 't1', prompt: 'Find suppliers' }, { id: 't2', prompt: 'Plan a trip' }),
    'GET /api/tasks?limit=20&q=sup': listed({ id: 't1', prompt: 'Find suppliers' }),
    'GET /api/tasks?limit=20&q=zzz': json({ tasks: [], nextCursor: null }),
  });
  view(app);
  await screen.findByRole('link', { name: /Plan a trip/ });
  const field = screen.getByRole('searchbox', { name: 'Search tasks' });

  await userEvent.type(field, 'sup');
  await until(() => screen.queryByRole('link', { name: /Plan a trip/ }) === null);
  screen.getByRole('link', { name: /Find suppliers/ });
  expect(calls.filter(c => c.path.startsWith('/api/tasks')).map(c => c.path)).toEqual([
    '/api/tasks?limit=20',
    '/api/tasks?limit=20&q=sup',
  ]);

  await userEvent.clear(field);
  await userEvent.type(field, 'zzz');
  await screen.findByText('No tasks match your search.');

  await userEvent.clear(field);
  await screen.findByRole('link', { name: /Plan a trip/ });
  expect(screen.queryByText('No tasks match your search.')).toBeNull();
});

test('the search stays when the Shell is mounted again on another screen', async () => {
  const { view, state, calls } = setup({
    ...signedIn(),
    'GET /api/tasks?limit=20&q=sup': listed({ id: 't1', prompt: 'Find suppliers' }),
  });
  await state.tasks.search('sup');
  view(app);
  expect((screen.getByRole('searchbox', { name: 'Search tasks' }) as HTMLInputElement).value).toBe('sup');
  await userEvent.click(await screen.findByRole('link', { name: /Find suppliers/ }));
  await until(() => location.pathname === '/tasks/t1');
  expect((screen.getByRole('searchbox', { name: 'Search tasks' }) as HTMLInputElement).value).toBe('sup');
  expect(calls.filter(c => c.path.startsWith('/api/tasks'))).toHaveLength(1);
});

test('a failed search shows a hint, and Try again repeats the same search', async () => {
  let failures = 1;
  const { view, calls } = setup({
    ...signedIn(),
    'GET /api/tasks?limit=20': listed({ id: 't1', prompt: 'Find suppliers' }, { id: 't2', prompt: 'Plan a trip' }),
    'GET /api/tasks?limit=20&q=sup': () =>
      failures-- > 0
        ? json({ error: { code: 'internal', message: 'boom' } }, 500)
        : listed({ id: 't1', prompt: 'Find suppliers' }),
  });
  view(app);
  await screen.findByRole('link', { name: /Plan a trip/ });
  await userEvent.type(screen.getByRole('searchbox', { name: 'Search tasks' }), 'sup');
  await screen.findByText('Could not search your tasks.');
  expect(screen.queryByRole('link', { name: /Plan a trip/ })).toBeNull();
  expect(screen.queryByText('No tasks match your search.')).toBeNull();

  await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await screen.findByRole('link', { name: /Find suppliers/ });
  expect(screen.queryByText('Could not search your tasks.')).toBeNull();
  expect(calls.filter(c => c.path === '/api/tasks?limit=20&q=sup')).toHaveLength(2);
});

const deleteTask = async (title: string) => {
  await userEvent.click(await screen.findByRole('button', { name: `Delete task ${title}` }));
  await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
  await until(() => screen.queryByRole('alertdialog') === null);
};

test('after a delete the focus moves to the next row, else the previous one, else the search; a toast says so', async () => {
  const { view } = setup(
    {
      ...signedIn(),
      'GET /api/tasks': listed(
        { id: 't1', prompt: 'First' },
        { id: 't2', prompt: 'Second' },
        { id: 't3', prompt: 'Third' },
      ),
      'DELETE /api/tasks/t1': noContent,
      'DELETE /api/tasks/t3': noContent,
      'DELETE /api/tasks/t2': noContent,
    },
    '/',
  );
  view(app);
  await deleteTask('First');
  await until(() => document.activeElement === screen.getByRole('button', { name: 'Delete task Second' }));
  expect(screen.getByText('Task deleted')).toBeTruthy();

  // Последняя строка: фокус на предыдущей.
  await deleteTask('Third');
  await until(() => document.activeElement === screen.getByRole('button', { name: 'Delete task Second' }));

  await deleteTask('Second');
  await until(() => document.activeElement === screen.getByRole('searchbox', { name: 'Search tasks' }));
});

test('a refused delete keeps the focus on the button that opened the dialog and shows no success toast', async () => {
  const { view } = setup(
    {
      ...signedIn(),
      'GET /api/tasks': listed({ id: 't1', prompt: 'First' }, { id: 't2', prompt: 'Second' }),
      'DELETE /api/tasks/t1': json({ error: { code: 'conflict', message: 'still running' } }, 409),
    },
    '/',
  );
  view(app);
  await deleteTask('First');
  await screen.findByText('Could not delete the task');
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Delete task First' }));
  expect(screen.queryByText('Task deleted')).toBeNull();
});

test('a task already deleted in another tab (404) leaves the sidebar without an error', async () => {
  const { view } = setup(
    {
      ...signedIn(),
      'GET /api/tasks': listed({ id: 't1', prompt: 'First' }, { id: 't2', prompt: 'Second' }),
      'DELETE /api/tasks/t1': json({ error: { code: 'not_found', message: 'task not found' } }, 404),
    },
    '/',
  );
  view(app);
  await deleteTask('First');
  await until(() => screen.queryByRole('link', { name: /First/ }) === null);
  expect(screen.queryByText('Could not delete the task')).toBeNull();
  expect(screen.getByRole('link', { name: /Second/ })).toBeTruthy();
});

test('every loaded task deleted while more pages exist: no empty hint, Load more stays', async () => {
  const { view } = setup(
    {
      ...signedIn(),
      'GET /api/tasks': json({ tasks: [taskSummary({ id: 't1', prompt: 'First' })], nextCursor: 'c1' }),
      'DELETE /api/tasks/t1': noContent,
    },
    '/',
  );
  view(app);
  await deleteTask('First');
  await until(() => screen.queryByRole('link', { name: /First/ }) === null);
  expect(screen.queryByText('No tasks yet.')).toBeNull();
  expect(screen.getByRole('button', { name: 'Load more' })).toBeTruthy();
});

test('the empty hints are announced as status', async () => {
  const { view } = setup({
    ...signedIn(),
    'GET /api/tasks?limit=20': json({ tasks: [], nextCursor: null }),
    'GET /api/tasks?limit=20&q=zzz': json({ tasks: [], nextCursor: null }),
  });
  view(app);
  expect((await screen.findByText('No tasks yet.')).getAttribute('role')).toBe('status');
  await userEvent.type(screen.getByRole('searchbox', { name: 'Search tasks' }), 'zzz');
  expect((await screen.findByText('No tasks match your search.')).getAttribute('role')).toBe('status');
});
