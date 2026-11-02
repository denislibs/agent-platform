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
