import { expect, test } from 'bun:test';
import { screen } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { Route, Router } from 'preact-iso';
import { Shell } from '../src/layout/shell.tsx';
import { usePage } from '../src/layout/page.ts';
import { json, me, taskSummary } from './fixtures.ts';
import { setup, signedIn, until } from './render.tsx';

function Page({ title }: { title: string }) {
  usePage(title);
  return (
    <Shell>
      <h1 class="ui-h1">{title}</h1>
      <a href="/api/files/f1">report.csv</a>
    </Shell>
  );
}

const Home = () => <Page title="New task" />;
const TaskPage = () => <Page title="Task" />;

const app = (
  <Router>
    <Route path="/" component={Home} />
    <Route path="/tasks/:id" component={TaskPage} />
  </Router>
);

test('the sidebar lists tasks with their status, marks the open one and pages with Load more', async () => {
  const first = [
    taskSummary({ id: 't1', prompt: 'Find suppliers\nin the EU' }),
    taskSummary({ id: 't2', status: 'waiting_user', prompt: 'Plan a trip' }),
  ];
  const { view, calls } = setup(
    {
      ...signedIn(),
      'GET /api/tasks?limit=20': json({ tasks: first, nextCursor: 'c1' }),
      'GET /api/tasks?limit=20&before=c1': json({
        tasks: [taskSummary({ id: 't3', status: 'done', prompt: 'Old one' })],
        nextCursor: null,
      }),
    },
    '/tasks/t1',
  );
  view(app);
  const nav = await screen.findByRole('navigation', { name: 'Tasks' });
  await until(() => nav.querySelectorAll('.ui-task-item').length === 2);
  const current = screen.getByRole('link', { name: /Find suppliers\s*, running/ });
  expect(current.getAttribute('aria-current')).toBe('page');
  expect(current.getAttribute('href')).toBe('/tasks/t1');
  expect(screen.getByRole('link', { name: /Plan a trip\s*, needs your answer/ })).toBeTruthy();

  await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
  await screen.findByRole('link', { name: /Old one\s*, completed/ });
  expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  expect(calls.filter(c => c.path.startsWith('/api/tasks')).map(c => c.path)).toEqual([
    '/api/tasks?limit=20',
    '/api/tasks?limit=20&before=c1',
  ]);
});

test('landmarks, the skip link and the credit balance as the API formats it', async () => {
  const { view, state } = setup({ ...signedIn(), 'GET /api/me': json(me({}, 12_345)) });
  await state.session.load();
  view(app);
  expect(screen.getByRole('complementary', { name: 'Sidebar' })).toBeTruthy();
  expect(screen.getByRole('main').id).toBe('main');
  expect(screen.getByRole('link', { name: 'Skip to content' }).getAttribute('href')).toBe('#main');
  expect(screen.getByText('12.345')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'New task' }).getAttribute('aria-current')).toBe('page');
});

test('a sidebar link navigates in place, sets the title and moves focus into <main>', async () => {
  const { view } = setup({
    ...signedIn(),
    'GET /api/tasks': json({ tasks: [taskSummary({ id: 't1' })], nextCursor: null }),
  });
  view(app);
  expect(document.title).toBe('New task · agent');
  const link = await screen.findByRole('link', { name: /Find three suppliers/ });
  await userEvent.click(link);
  await screen.findByRole('heading', { name: 'Task' });
  expect(location.pathname).toBe('/tasks/t1');
  expect(document.title).toBe('Task · agent');
  await until(() => document.activeElement?.id === 'main');
});

test('download links under /api/ are left to the browser, not the router', async () => {
  const { view } = setup(signedIn());
  view(app);
  let routed: boolean | undefined;
  const watch = (event: MouseEvent) => {
    routed = event.defaultPrevented;
    event.preventDefault(); // happy-dom не должен уходить со страницы
  };
  addEventListener('click', watch);
  try {
    await userEvent.click(screen.getByRole('link', { name: 'report.csv' }));
  } finally {
    removeEventListener('click', watch);
  }
  expect(routed).toBe(false);
  expect(location.pathname).toBe('/');
});
