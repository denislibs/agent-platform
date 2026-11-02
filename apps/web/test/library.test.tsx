import { expect, test } from 'bun:test';
import { act, screen, within } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { LibraryPage } from '../src/routes/library.tsx';
import { fileDto, json, noContent } from './fixtures.ts';
import { setup, signedIn, until } from './render.tsx';

const page = (files: Array<ReturnType<typeof fileDto>>, nextCursor: string | null = null) =>
  json({ files, nextCursor });
const report = fileDto({ id: 'f1', taskId: 't1', path: 'outputs/report.csv', size: 2048 });
const fileCalls = (calls: Array<{ method: string; path: string }>) =>
  calls.filter(c => c.method === 'GET' && c.path.startsWith('/api/files')).map(c => c.path);

test('rows show the name, task link, size, date and download; Load more pages; the sidebar marks the page', async () => {
  const { view, calls } = setup(
    {
      ...signedIn(),
      'GET /api/files?limit=20': page([report], 'c1'),
      'GET /api/files?limit=20&before=c1': page([fileDto({ id: 'f2', path: 'outputs/old.md' }), report]),
    },
    '/library',
  );
  view(<LibraryPage />);
  expect(document.title).toBe('Library · agent');
  expect(screen.getByRole('link', { name: 'Library' }).getAttribute('aria-current')).toBe('page');
  await screen.findByText('report.csv');
  expect(screen.getByText(/^2 KB · Nov 2, 2026$/)).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Open task' }).getAttribute('href')).toBe('/tasks/t1');
  expect(screen.getByRole('link', { name: 'Download report.csv' }).getAttribute('href')).toBe('/api/files/f1');

  await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
  await screen.findByText('old.md');
  expect(screen.getAllByText('report.csv')).toHaveLength(1);
  expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  expect(fileCalls(calls)).toEqual(['/api/files?limit=20', '/api/files?limit=20&before=c1']);
});

test('filter tabs and the search ask the API; nothing found says so; no files at all says so differently', async () => {
  const { view, calls } = setup(
    {
      ...signedIn(),
      'GET /api/files?limit=20': page([]),
      'GET /api/files?limit=20&category=images': page([fileDto({ id: 'f3', path: 'outputs/chart.png' })]),
      'GET /api/files?limit=20&category=images&q=zzz': page([]),
    },
    '/library',
  );
  view(<LibraryPage />);
  await screen.findByText('No files yet');
  await userEvent.click(screen.getByRole('tab', { name: 'Images' }));
  await screen.findByText('chart.png');
  await userEvent.type(screen.getByRole('searchbox', { name: 'Search files' }), 'zzz');
  await screen.findByText('No files match');
  expect(fileCalls(calls)).toEqual([
    '/api/files?limit=20',
    '/api/files?limit=20&category=images',
    '/api/files?limit=20&category=images&q=zzz',
  ]);
});

test('deleting a file asks first and removes the row; a failure is shown and the row stays', async () => {
  const { view, calls } = setup(
    {
      ...signedIn(),
      'GET /api/files': page([report, fileDto({ id: 'f2', path: 'outputs/kept.md' })]),
      'DELETE /api/files/f1': noContent,
      'DELETE /api/files/f2': json({ error: { code: 'internal', message: 'boom' } }, 500),
    },
    '/library',
  );
  view(<LibraryPage />);
  await userEvent.click(await screen.findByRole('button', { name: 'Delete report.csv' }));
  const dialog = await screen.findByRole('alertdialog', { name: 'Delete this file?' });
  expect(calls.some(c => c.method === 'DELETE')).toBe(false);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
  await until(() => screen.queryByText('report.csv') === null);
  expect(calls.filter(c => c.method === 'DELETE').map(c => c.path)).toEqual(['/api/files/f1']);

  await until(() => screen.queryByRole('alertdialog') === null);
  await userEvent.click(screen.getByRole('button', { name: 'Delete kept.md' }));
  await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
  await screen.findByText('Could not delete the file');
  expect(screen.getByText('kept.md')).toBeTruthy();
});

test('a failed load offers Retry', async () => {
  let reads = 0;
  const { view } = setup(
    {
      ...signedIn(),
      'GET /api/files': () =>
        reads++ === 0 ? json({ error: { code: 'internal', message: 'boom' } }, 500) : page([report]),
    },
    '/library',
  );
  view(<LibraryPage />);
  await screen.findByText('Could not load files');
  await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByText('report.csv');
  expect(screen.queryByText('Could not load files')).toBeNull();
});

test('deleting a task from the sidebar reloads the Library: its files are gone', async () => {
  let reads = 0;
  const { view, state, calls } = setup(
    {
      ...signedIn(),
      'GET /api/files': () => (reads++ === 0 ? page([report]) : page([])),
      'DELETE /api/tasks/t1': noContent,
    },
    '/library',
  );
  view(<LibraryPage />);
  await screen.findByText('report.csv');
  await act(() => state.tasks.remove('t1'));
  await screen.findByText('No files yet');
  expect(fileCalls(calls)).toHaveLength(2);
});
