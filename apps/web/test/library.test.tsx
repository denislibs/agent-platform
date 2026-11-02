import { expect, test } from 'bun:test';
import { act, screen, within } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { LibraryPage } from '../src/routes/library.tsx';
import { formatDate } from '../src/view/format.ts';
import { fileDto, json, noContent } from './fixtures.ts';
import { setup, signedIn, until } from './render.tsx';

const page = (files: Array<ReturnType<typeof fileDto>>, nextCursor: string | null = null) =>
  json({ files, nextCursor });
const report = fileDto({ id: 'f1', taskId: 't1', path: 'outputs/report.csv', size: 2048 });
const chart = fileDto({ id: 'f3', path: 'outputs/chart.png' });
const notes = fileDto({ id: 'f4', path: 'outputs/notes.md', mime: 'text/markdown' });
const zzz = fileDto({ id: 'f5', path: 'outputs/zzz.md', mime: 'text/markdown' });
const failure = () => json({ error: { code: 'internal', message: 'boom' } }, 500);
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
  expect(screen.getByText(`2 KB · ${formatDate(report.createdAt)}`)).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Open task of report.csv' }).getAttribute('href')).toBe('/tasks/t1');
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

test('a failed filter change shows no old rows and no Load more; Retry fills the list', async () => {
  let documents = 0;
  const { view } = setup(
    {
      ...signedIn(),
      'GET /api/files?limit=20': page([chart], 'c1'),
      'GET /api/files?limit=20&category=documents': () => (documents++ === 0 ? failure() : page([notes])),
    },
    '/library',
  );
  view(<LibraryPage />);
  await screen.findByText('chart.png');
  await userEvent.click(screen.getByRole('tab', { name: 'Documents' }));
  await screen.findByText('Could not load files');
  expect(screen.queryByText('chart.png')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  expect(screen.queryByText('No files match')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByText('notes.md');
  expect(screen.queryByText('Could not load files')).toBeNull();
  expect(screen.queryByText('chart.png')).toBeNull();
});

test('a failed search shows no old rows and no Load more; Retry fills the list', async () => {
  let searches = 0;
  const { view } = setup(
    {
      ...signedIn(),
      'GET /api/files?limit=20': page([chart], 'c1'),
      'GET /api/files?limit=20&q=zzz': () => (searches++ === 0 ? failure() : page([zzz])),
    },
    '/library',
  );
  view(<LibraryPage />);
  await screen.findByText('chart.png');
  await userEvent.type(screen.getByRole('searchbox', { name: 'Search files' }), 'zzz');
  await screen.findByText('Could not load files');
  expect(screen.queryByText('chart.png')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  expect(screen.queryByText('No files match')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByText('zzz.md');
  expect(screen.queryByText('Could not load files')).toBeNull();
});

test('a file deleted while a list request is in flight stays deleted; Load more is not stuck busy', async () => {
  let reads = 0;
  let release!: (res: Response) => void;
  const late = new Promise<Response>(resolve => (release = resolve));
  const { view, state } = setup(
    {
      ...signedIn(),
      'GET /api/files': () => {
        reads++;
        if (reads === 1) return page([report, notes], 'c1');
        if (reads === 2) return late;
        return page([notes], 'c1');
      },
      'DELETE /api/files/f1': noContent,
      'DELETE /api/tasks/t1': noContent,
    },
    '/library',
  );
  view(<LibraryPage />);
  await screen.findByText('report.csv');
  // Задача удалена в сайдбаре: Library перечитывает файлы, и этот запрос остаётся в полёте.
  await act(() => state.tasks.remove('t1'));
  await until(() => reads === 2);
  expect(screen.getByRole('button', { name: 'Load more' }).getAttribute('aria-busy')).toBe('true');
  await userEvent.click(screen.getByRole('button', { name: 'Delete report.csv' }));
  await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
  await until(() => screen.queryByText('report.csv') === null);
  // Старый ответ приходит уже после удаления и снова содержит файл: его не должно быть на экране.
  release(page([report, notes], 'c1'));
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(screen.queryByText('report.csv')).toBeNull();
  expect(screen.getByText('notes.md')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Load more' }).getAttribute('aria-busy')).toBeNull();
});

const deleteFile = async (name: string) => {
  await userEvent.click(screen.getByRole('button', { name: `Delete ${name}` }));
  await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
  await until(() => screen.queryByRole('alertdialog') === null);
};

test('after a delete the focus moves to the next row, else the previous one, else the search; a toast says so', async () => {
  const { view } = setup(
    {
      ...signedIn(),
      'GET /api/files': page([report, chart, notes]),
      'DELETE /api/files/f1': noContent,
      'DELETE /api/files/f3': noContent,
      'DELETE /api/files/f4': noContent,
    },
    '/library',
  );
  view(<LibraryPage />);
  await screen.findByText('report.csv');

  await deleteFile('report.csv');
  await until(() => document.activeElement === screen.getByRole('button', { name: 'Delete chart.png' }));
  expect(screen.getByText('File deleted')).toBeTruthy();

  // Последняя строка: фокус на предыдущей.
  await deleteFile('notes.md');
  await until(() => document.activeElement === screen.getByRole('button', { name: 'Delete chart.png' }));

  await deleteFile('chart.png');
  await until(() => document.activeElement === screen.getByRole('searchbox', { name: 'Search files' }));
});

test('a failed delete keeps the focus on the button that opened the dialog and shows no success toast', async () => {
  const { view } = setup(
    {
      ...signedIn(),
      'GET /api/files': page([report, chart]),
      'DELETE /api/files/f1': failure,
    },
    '/library',
  );
  view(<LibraryPage />);
  await screen.findByText('report.csv');
  await deleteFile('report.csv');
  await screen.findByText('Could not delete the file');
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Delete report.csv' }));
  expect(screen.queryByText('File deleted')).toBeNull();
});

test('a file already deleted elsewhere (404) leaves the list without an error', async () => {
  const { view } = setup(
    {
      ...signedIn(),
      'GET /api/files': page([report, chart]),
      'DELETE /api/files/f1': json({ error: { code: 'not_found', message: 'file not found' } }, 404),
    },
    '/library',
  );
  view(<LibraryPage />);
  await screen.findByText('report.csv');
  await deleteFile('report.csv');
  await until(() => screen.queryByText('report.csv') === null);
  expect(screen.queryByText('Could not delete the file')).toBeNull();
  expect(screen.getByText('chart.png')).toBeTruthy();
});

test('every loaded row deleted while more pages exist: no empty state, Load more stays', async () => {
  const { view } = setup(
    {
      ...signedIn(),
      'GET /api/files': page([report], 'c1'),
      'DELETE /api/files/f1': noContent,
    },
    '/library',
  );
  view(<LibraryPage />);
  await screen.findByText('report.csv');
  await deleteFile('report.csv');
  await until(() => screen.queryByText('report.csv') === null);
  expect(screen.queryByText('No files yet')).toBeNull();
  expect(screen.queryByText('No files match')).toBeNull();
  expect(screen.getByRole('button', { name: 'Load more' })).toBeTruthy();
});

test('the empty states are announced as status', async () => {
  const { view } = setup(
    {
      ...signedIn(),
      'GET /api/files?limit=20': page([]),
      'GET /api/files?limit=20&q=zzz': page([]),
    },
    '/library',
  );
  view(<LibraryPage />);
  const empty = await screen.findByText('No files yet');
  expect(empty.closest('[role="status"]')).not.toBeNull();
  await userEvent.type(screen.getByRole('searchbox', { name: 'Search files' }), 'zzz');
  const none = await screen.findByText('No files match');
  expect(none.closest('[role="status"]')).not.toBeNull();
});
