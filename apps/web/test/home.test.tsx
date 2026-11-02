import { expect, test } from 'bun:test';
import { screen } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { Home } from '../src/routes/home.tsx';
import { baseName, fileMeta, formatBytes } from '../src/view/format.ts';
import { fileDto, json, me, taskDetail } from './fixtures.ts';
import { setup, signedIn, until } from './render.tsx';

const created = json({ task: taskDetail({ id: 'new-1', status: 'queued', prompt: 'Summarise data.csv' }) }, 201);

function uploads(contentType = 'text/csv') {
  let n = 0;
  return () => {
    n++;
    return json(
      {
        file: fileDto({ id: `in-${n}`, kind: 'input', path: `f${n}`, mime: contentType }),
        upload: { url: `http://s3.test/in-${n}`, method: 'PUT', headers: { 'content-type': contentType } },
      },
      201,
    );
  };
}

test('a task starts from the composer and the app opens its screen', async () => {
  const { view, calls, state } = setup({ ...signedIn(), 'POST /api/tasks': created });
  await state.session.load();
  view(<Home />);
  expect(document.title).toBe('New task · agent');
  await userEvent.type(screen.getByRole('textbox', { name: 'Task' }), 'Summarise data.csv{Enter}');
  await until(() => location.pathname === '/tasks/new-1');
  expect(calls.find(c => c.path === '/api/tasks' && c.method === 'POST')?.body).toEqual({
    prompt: 'Summarise data.csv',
    fileIds: [],
  });
  expect(state.tasks.items.value[0]?.id).toBe('new-1');
});

test('attached files upload at once to S3 and go with the task as fileIds', async () => {
  const puts: string[] = [];
  const { view, calls, state } = setup({
    ...signedIn(),
    'GET /api/config': json({ providers: [], uploadMaxBytes: 1024 }),
    'POST /api/uploads': uploads(),
    'POST /api/tasks': created,
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    puts.push(url);
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  try {
    await state.session.load();
    view(<Home />);
    const picker = document.querySelector<HTMLInputElement>('input[type=file]')!;
    await userEvent.upload(picker, [new File(['a,b'], 'data.csv', { type: 'text/csv' })]);
    await screen.findByText('Spreadsheet · 3 B');
    expect(puts).toEqual(['http://s3.test/in-1']);
    await userEvent.type(screen.getByRole('textbox', { name: 'Task' }), 'Summarise data.csv{Enter}');
    await until(() => location.pathname === '/tasks/new-1');
    expect(calls.find(c => c.path === '/api/tasks')?.body).toEqual({ prompt: 'Summarise data.csv', fileIds: ['in-1'] });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('files over the limit, empty files and duplicate names are refused before any upload', async () => {
  const { view, calls, state } = setup({
    ...signedIn(),
    'GET /api/config': json({ providers: [], uploadMaxBytes: 4 }),
  });
  await state.session.load();
  view(<Home />);
  const picker = document.querySelector<HTMLInputElement>('input[type=file]')!;
  await userEvent.upload(picker, [new File(['too big'], 'big.csv'), new File([], 'empty.csv')]);
  await screen.findByText('big.csv cannot be attached');
  await screen.findByText('empty.csv cannot be attached');
  expect(calls.some(c => c.path === '/api/uploads')).toBe(false);
  expect(screen.queryByRole('listitem')).toBeNull();
});

test('a refused task keeps the text and explains why', async () => {
  const { view, state } = setup({
    ...signedIn(),
    'POST /api/tasks': json(
      { error: { code: 'too_many_active_tasks', message: 'You already have 2 running tasks.' } },
      429,
    ),
  });
  await state.session.load();
  view(<Home />);
  const box = screen.getByRole('textbox', { name: 'Task' }) as HTMLTextAreaElement;
  await userEvent.type(box, 'One more{Enter}');
  await screen.findByText('You already have 2 running tasks.');
  expect(box.value).toBe('One more');
  expect(location.pathname).toBe('/');
});

test('with no credits left the screen warns before the user types', async () => {
  const { view, state } = setup({ ...signedIn(), 'GET /api/me': json(me({}, 0)) });
  await state.session.load();
  view(<Home />);
  expect(screen.getByText('You are out of credits')).toBeTruthy();
});

test('a second file with the same name is refused', async () => {
  const { view, calls, state } = setup({
    ...signedIn(),
    'POST /api/uploads': uploads(),
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
  try {
    await state.session.load();
    view(<Home />);
    const picker = document.querySelector<HTMLInputElement>('input[type=file]')!;
    await userEvent.upload(picker, [new File(['a'], 'data.csv', { type: 'text/csv' })]);
    await screen.findByText('Spreadsheet · 1 B');
    await userEvent.upload(picker, [new File(['b'], 'data.csv', { type: 'text/csv' })]);
    await screen.findByText('data.csv is already attached');
    expect(calls.filter(c => c.path === '/api/uploads')).toHaveLength(1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('removing a file mid-upload aborts its PUT and the task goes without it', async () => {
  let signal: AbortSignal | null | undefined;
  const { view, calls, state } = setup({
    ...signedIn(),
    'POST /api/uploads': uploads(),
    'POST /api/tasks': created,
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((_url: string, init?: RequestInit) => {
    signal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  }) as typeof fetch;
  try {
    await state.session.load();
    view(<Home />);
    const picker = document.querySelector<HTMLInputElement>('input[type=file]')!;
    await userEvent.upload(picker, [new File(['a'], 'data.csv', { type: 'text/csv' })]);
    await screen.findByText('Uploading…');
    await until(() => signal !== undefined);
    await userEvent.click(screen.getByRole('button', { name: /Remove data\.csv/ }));
    await until(() => signal?.aborted === true);
    expect(screen.queryByText('Uploading…')).toBeNull();
    // Об оборванной загрузке тоста нет.
    expect(screen.queryByText('Could not upload data.csv')).toBeNull();
    await userEvent.type(screen.getByRole('textbox', { name: 'Task' }), 'Go{Enter}');
    await until(() => location.pathname === '/tasks/new-1');
    expect(calls.find(c => c.path === '/api/tasks')?.body).toEqual({ prompt: 'Go', fileIds: [] });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the task is not sent while a file is still uploading', async () => {
  const { view, calls, state } = setup({
    ...signedIn(),
    'POST /api/uploads': uploads(),
    'POST /api/tasks': created,
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
  try {
    await state.session.load();
    view(<Home />);
    const picker = document.querySelector<HTMLInputElement>('input[type=file]')!;
    await userEvent.upload(picker, [new File(['a'], 'data.csv', { type: 'text/csv' })]);
    await screen.findByText('Uploading…');
    await userEvent.type(screen.getByRole('textbox', { name: 'Task' }), 'Go{Enter}');
    await screen.findByText('Wait for the uploads to finish');
    expect(calls.some(c => c.path === '/api/tasks')).toBe(false);
    expect(location.pathname).toBe('/');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('file sizes and kinds read as short labels', () => {
  expect(formatBytes(394)).toBe('394 B');
  expect(formatBytes(84 * 1024)).toBe('84 KB');
  expect(formatBytes(1.2 * 1024 * 1024)).toBe('1.2 MB');
  expect(fileMeta('a.csv', 84 * 1024)).toBe('Spreadsheet · 84 KB');
  expect(baseName('outputs/a.csv')).toBe('a.csv');
  expect(baseName('a.csv')).toBe('a.csv');
});
