import { expect, test } from 'bun:test';
import { act, fireEvent, screen, within } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import type { StepDto, TaskStatus } from '@agent/shared';
import { TaskScreen } from '../src/routes/task.tsx';
import { fileDto, json, status, step, subtask, taskDetail, taskResponse, toolStep } from './fixtures.ts';
import { setup, signedIn, until } from './render.tsx';
import { FakeEventSource, manualTimers } from './sse.ts';

/** Живой регион статуса задачи (у индикатора «думает» своя роль status). */
const liveStatus = () => document.getElementById('task-status')?.textContent;

const prompt = step(
  1,
  { type: 'message', role: 'user', text: 'Find three suppliers' },
  { agent: 'user', subtaskId: null },
);

/** Вопрос агента: вызов ask_user и его результат с управляющим сигналом. */
const ask = (seq: number, question: string) =>
  toolStep(seq, 'ask_user', { question }, { control: { kind: 'ask_user', question } });

/** Шаги из потока задачи — как их присылает API. */
const emit = (...steps: StepDto[]) =>
  act(() => {
    for (const s of steps) FakeEventSource.last.emit('step', s, String(s.seq));
  });

/** Экран задачи с карточкой из responses (по очереди на каждое чтение) и открытым потоком шагов. */
async function open(
  responses: Array<ReturnType<typeof taskResponse>>,
  extra: Parameters<typeof setup>[0] = {},
  deps: Parameters<typeof setup>[2] = {},
) {
  let reads = 0;
  const env = setup(
    {
      ...signedIn(),
      'GET /api/tasks/task-1': () => json(responses[Math.min(reads++, responses.length - 1)]),
      ...extra,
    },
    '/tasks/task-1',
    deps,
  );
  env.view(<TaskScreen id="task-1" />);
  await until(() => FakeEventSource.all.length > 0);
  return env;
}

test('a running task shows the plan, the steps as they stream and the latest tool on the computer', async () => {
  await open([
    taskResponse({
      task: taskDetail({ status: 'running' }),
      subtasks: [
        subtask(0, { goal: 'Search suppliers', status: 'running', doneCriteria: 'Three names' }),
        subtask(1, { goal: 'Write the CSV' }),
      ],
    }),
  ]);
  await until(() => document.title === 'Find three suppliers · agent');
  expect(liveStatus()).toBe('The agent is working.');
  const plan = screen.getByRole('list', { name: 'Plan' });
  expect(
    within(plan)
      .getAllByRole('listitem')
      .map(i => i.getAttribute('data-status')),
  ).toEqual(['running', 'pending']);

  emit(prompt, ...toolStep(2, 'web_search', { query: 'steel suppliers' }, { output: '1. Acme Steel' }));
  emit(
    ...toolStep(4, 'browser_open', { url: 'https://acme.test' }, { output: 'URL: https://acme.test\n\n# Acme Steel' }),
  );
  expect(screen.getByRole('button', { name: '2 steps' }).getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByText('Searching "steel suppliers"')).toBeTruthy();
  const computer = screen.getByRole('region', { name: "Agent's computer" });
  expect(within(computer).getByText('Using Browser')).toBeTruthy();
  // Заголовки Markdown на уровень ниже: h1 страницы — один.
  expect(within(computer).getByRole('heading', { level: 2, name: 'Acme Steel' })).toBeTruthy();

  await userEvent.click(within(computer).getByRole('button', { name: 'Previous step' }));
  expect(within(computer).getByText('1. Acme Steel')).toBeTruthy();
  await userEvent.click(within(computer).getByRole('button', { name: 'Jump to live' }));
  expect(within(computer).getByText('Using Browser')).toBeTruthy();
  // Живой регион объявляет смену статуса, а не каждый шаг.
  expect(liveStatus()).toBe('The agent is working.');
  expect(screen.getAllByRole('heading', { level: 1 }).map(h => h.textContent)).toEqual(['Find three suppliers']);
  // Статус объявляет только #task-status: индикатор «думает» молчит.
  expect(screen.getByText('Working…').closest('[role="status"]')).toBeNull();
});

test('the agent question takes an answer that carries the pause seq', async () => {
  const { calls } = await open(
    [
      taskResponse({ task: taskDetail({ status: 'running' }) }),
      taskResponse({ task: taskDetail({ status: 'waiting_user', lastSeq: 4 }) }),
    ],
    { 'POST /api/tasks/task-1/messages': json({ task: taskDetail({ status: 'waiting_user', lastSeq: 5 }) }, 202) },
  );
  emit(
    prompt,
    ...toolStep(
      2,
      'ask_user',
      { question: 'Which region?' },
      { control: { kind: 'ask_user', question: 'Which region?' } },
    ),
    status(4, 'running', 'waiting_user'),
  );
  const card = await screen.findByRole('region', { name: 'Your agent needs an answer' });
  expect(liveStatus()).toBe('The agent needs your answer.');
  await userEvent.type(within(card).getByRole('textbox'), 'EU only{Enter}');
  await until(() => calls.some(c => c.path === '/api/tasks/task-1/messages'));
  expect(calls.find(c => c.path === '/api/tasks/task-1/messages')?.body).toEqual({ text: 'EU only', questionSeq: 4 });
  emit(step(5, { type: 'message', role: 'user', text: 'EU only' }, { agent: 'user', subtaskId: null }));
  expect(screen.queryByRole('region', { name: 'Your agent needs an answer' })).toBeNull();
  expect(screen.getByText('Which region?')).toBeTruthy();
  expect(screen.getByText('EU only')).toBeTruthy();
});

test('an answer to a question the agent replaced keeps the typed text and shows the new question', async () => {
  let replies = 0;
  const { calls } = await open(
    [
      taskResponse({ task: taskDetail({ status: 'running' }) }),
      taskResponse({ task: taskDetail({ status: 'waiting_user', lastSeq: 4 }) }),
    ],
    {
      'POST /api/tasks/task-1/messages': () =>
        replies++ === 0
          ? json({ error: { code: 'conflict', message: 'the agent has asked another question since' } }, 409)
          : json({ task: taskDetail({ status: 'waiting_user', lastSeq: 9 }) }, 202),
    },
  );
  emit(prompt, ...ask(2, 'Which region?'), status(4, 'running', 'waiting_user'));
  const card = await screen.findByRole('region', { name: 'Your agent needs an answer' });
  await userEvent.type(within(card).getByRole('textbox'), 'EU only{Enter}');
  expect(await screen.findByText('The question has changed')).toBeTruthy();
  // Карточка перечитана, набранный ответ не пропал.
  await until(() => calls.filter(c => c.method === 'GET' && c.path === '/api/tasks/task-1').length >= 3);
  emit(status(5, 'waiting_user', 'running'), ...ask(6, 'Which country?'), status(8, 'running', 'waiting_user'));
  const next = screen.getByRole('region', { name: 'Your agent needs an answer' });
  expect(within(next).getByText('Which country?')).toBeTruthy();
  const field = within(next).getByRole('textbox') as HTMLInputElement;
  expect(field.value).toBe('EU only');
  await userEvent.type(field, '{Enter}');
  await until(() => calls.filter(c => c.path === '/api/tasks/task-1/messages').length === 2);
  expect(calls.filter(c => c.path === '/api/tasks/task-1/messages').map(c => c.body)).toEqual([
    { text: 'EU only', questionSeq: 4 },
    { text: 'EU only', questionSeq: 8 },
  ]);
});

test('a finished task shows the answer as Markdown, the files to download and a completed badge', async () => {
  const done = taskResponse({
    task: taskDetail({
      status: 'done',
      result: '# Suppliers\n\nFound **3** suppliers.',
      finishedAt: '2026-11-02T10:01:27.000Z',
    }),
    files: [fileDto({ id: 'f1', path: 'outputs/suppliers.csv', size: 394 })],
  });
  const { state } = await open([done], {});
  emit(
    prompt,
    ...toolStep(2, 'web_search', { query: 'a' }),
    ...toolStep(4, 'file_write', { path: 'outputs/suppliers.csv' }),
  );
  act(() => FakeEventSource.last.emit('end', { status: 'done' }));
  await screen.findByText('Task completed');
  expect(screen.getByText('3').tagName).toBe('STRONG');
  expect(screen.getByRole('heading', { level: 2, name: 'Suppliers' })).toBeTruthy();
  expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  const file = screen.getByRole('link', { name: /suppliers\.csv/ });
  expect(file.getAttribute('href')).toBe('/api/files/f1');
  expect(screen.getByText('Spreadsheet · 394 B')).toBeTruthy();
  expect(screen.getByText('Worked for 1m 27s')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Searched 1 query · Wrote 1 file' }).getAttribute('aria-expanded')).toBe(
    'false',
  );
  expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  expect(state.tasks.items.value[0]).toMatchObject({ id: 'task-1', status: 'done' });
  expect(liveStatus()).toBe('The task is complete.');
});

test('an end event with an unreadable status still re-reads the task', async () => {
  await open([
    taskResponse({ task: taskDetail({ status: 'running' }) }),
    taskResponse({ task: taskDetail({ status: 'done', result: 'All set' }) }),
  ]);
  act(() => FakeEventSource.last.emitRaw('end', 'not json'));
  expect(await screen.findByText('Task completed')).toBeTruthy();
  expect(screen.getByText('All set')).toBeTruthy();
});

test('partial results and failures explain themselves', async () => {
  await open([taskResponse({ task: taskDetail({ status: 'failed' }) })]);
  emit(prompt, status(2, 'running', 'failed', 'the sandbox stopped responding'));
  await screen.findByText('the sandbox stopped responding');
  expect(screen.getByText('The task failed')).toBeTruthy();
});

test('a partial result names the limit it hit', async () => {
  await open([
    taskResponse({ task: taskDetail({ status: 'done', partial: true, stopReason: 'credits', result: 'Half done' }) }),
  ]);
  expect(await screen.findByText('The agent stopped early because your credits ran out.')).toBeTruthy();
});

test('Stop asks for confirmation, then cancels the task', async () => {
  const { calls } = await open(
    [
      taskResponse({ task: taskDetail({ status: 'running' }) }),
      taskResponse({ task: taskDetail({ status: 'cancelled' }) }),
    ],
    { 'POST /api/tasks/task-1/cancel': json({ task: taskDetail({ status: 'cancelled' }) }) },
  );
  await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
  const dialog = await screen.findByRole('alertdialog', { name: 'Stop the task?' });
  await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  await until(() => screen.queryByRole('alertdialog') === null);
  expect(calls.some(c => c.path === '/api/tasks/task-1/cancel')).toBe(false);

  await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
  await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Stop task' }));
  await screen.findByText('Stopped');
  expect(calls.some(c => c.path === '/api/tasks/task-1/cancel')).toBe(true);
  await until(() => screen.queryByRole('alertdialog') === null);
  expect(liveStatus()).toBe('The task was stopped.');
});

test('stopping a task that has already finished shows how it ended', async () => {
  await open(
    [
      taskResponse({ task: taskDetail({ status: 'running' }) }),
      taskResponse({ task: taskDetail({ status: 'done', result: 'Done before the stop' }) }),
    ],
    {
      'POST /api/tasks/task-1/cancel': json({ error: { code: 'conflict', message: 'the task is already done' } }, 409),
    },
  );
  await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
  await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Stop task' }));
  expect(await screen.findByText('The task has already finished')).toBeTruthy();
  expect(await screen.findByText('Task completed')).toBeTruthy();
  expect(screen.getByText('Done before the stop')).toBeTruthy();
  await until(() => screen.queryByRole('alertdialog') === null);
});

test('a failed refresh marks the page as possibly out of date without hiding it', async () => {
  let reads = 0;
  await open([], {
    'GET /api/tasks/task-1': () =>
      ++reads === 2
        ? json({ error: { code: 'internal', message: 'db down' } }, 500)
        : json(taskResponse({ task: taskDetail({ status: reads === 1 ? 'running' : 'waiting_user' }) })),
  });
  emit(prompt, status(2, 'running', 'waiting_user'));
  const notice = await screen.findByText('This page may be out of date.');
  expect(screen.getByText('Find three suppliers', { selector: '.ui-msg-user' })).toBeTruthy();
  expect(notice.closest('.ui-alert')?.textContent).not.toContain('db down');
  await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await until(() => screen.queryByText('This page may be out of date.') === null);
  expect(liveStatus()).toBe('The agent needs your answer.');
});

test('steps that could not be read are counted, not silently dropped', async () => {
  await open([taskResponse({ task: taskDetail({ status: 'running' }) })]);
  act(() => FakeEventSource.last.emitRaw('step', '{"seq": "broken"', '2'));
  expect(await screen.findByText("Some steps couldn't be displayed.")).toBeTruthy();
});

test('a task that failed to load offers a retry', async () => {
  let reads = 0;
  const env = setup(
    {
      ...signedIn(),
      'GET /api/tasks/task-1': () =>
        reads++ === 0
          ? json({ error: { code: 'internal', message: 'relation "tasks" does not exist' } }, 500)
          : json(taskResponse({ task: taskDetail({ status: 'running' }) })),
    },
    '/tasks/task-1',
  );
  env.view(<TaskScreen id="task-1" />);
  expect(await screen.findByText('Could not load the task')).toBeTruthy();
  expect(screen.queryByText(/relation/)).toBeNull();
  expect(FakeEventSource.all).toHaveLength(0);
  await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await until(() => FakeEventSource.all.length === 1);
  expect(await screen.findByText('Find three suppliers', { selector: '.ui-msg-user' })).toBeTruthy();
});

test('an unknown task says so instead of spinning', async () => {
  const env = setup(
    { ...signedIn(), 'GET /api/tasks/nope': json({ error: { code: 'not_found', message: 'task not found' } }, 404) },
    '/tasks/nope',
  );
  env.view(<TaskScreen id="nope" />);
  expect(await screen.findByText('Task not found')).toBeTruthy();
  expect(FakeEventSource.all).toHaveLength(0);
});

test('an accepted answer closes the question until the agent picks it up, and a double Enter sends once', async () => {
  const { calls } = await open(
    [
      taskResponse({ task: taskDetail({ status: 'running' }) }),
      taskResponse({ task: taskDetail({ status: 'waiting_user', lastSeq: 4 }) }),
    ],
    { 'POST /api/tasks/task-1/messages': json({ task: taskDetail({ status: 'waiting_user', lastSeq: 5 }) }, 202) },
  );
  emit(prompt, ...ask(2, 'Which region?'), status(4, 'running', 'waiting_user'));
  const card = await screen.findByRole('region', { name: 'Your agent needs an answer' });
  const field = within(card).getByRole('textbox');
  await userEvent.type(field, 'EU only');
  // Два Enter в одном такте: второй не должен уйти, пока первый в полёте.
  act(() => {
    fireEvent.keyDown(field, { key: 'Enter' });
    fireEvent.keyDown(field, { key: 'Enter' });
  });
  await until(() => screen.queryByRole('region', { name: 'Your agent needs an answer' }) === null);
  // 202 без эха в ленте: задача всё ещё waiting_user, но вопрос уже отвечен.
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(screen.queryByRole('region', { name: 'Your agent needs an answer' })).toBeNull();
  expect(calls.filter(c => c.path === '/api/tasks/task-1/messages')).toHaveLength(1);
});

test('an unsent answer does not prefill a later question once the first one is gone', async () => {
  await open(
    [
      taskResponse({ task: taskDetail({ status: 'running' }) }),
      taskResponse({ task: taskDetail({ status: 'waiting_user', lastSeq: 4 }) }),
      taskResponse({ task: taskDetail({ status: 'running', lastSeq: 5 }) }),
      taskResponse({ task: taskDetail({ status: 'waiting_user', lastSeq: 8 }) }),
    ],
    {
      'POST /api/tasks/task-1/messages': json(
        { error: { code: 'conflict', message: 'the task is not waiting for an answer' } },
        409,
      ),
    },
  );
  emit(prompt, ...ask(2, 'Which region?'), status(4, 'running', 'waiting_user'));
  const card = await screen.findByRole('region', { name: 'Your agent needs an answer' });
  await userEvent.type(within(card).getByRole('textbox'), 'EU only{Enter}');
  // Перечитанная задача уже работает: вопрос ушёл вместе с недоставленным ответом.
  await until(() => screen.queryByRole('region', { name: 'Your agent needs an answer' }) === null);
  emit(status(5, 'waiting_user', 'running'), ...ask(6, 'Which country?'), status(8, 'running', 'waiting_user'));
  const next = await screen.findByRole('region', { name: 'Your agent needs an answer' });
  expect(within(next).getByText('Which country?')).toBeTruthy();
  expect((within(next).getByRole('textbox') as HTMLInputElement).value).toBe('');
});

test('the agent question shows only while the task waits on that pause', async () => {
  // waiting_user, а шага паузы в ленте ещё нет: вопроса не показать.
  await open([taskResponse({ task: taskDetail({ status: 'waiting_user' }) })]);
  emit(prompt, ...ask(2, 'Which region?'));
  await screen.findByText('Find three suppliers', { selector: '.ui-msg-user' });
  expect(screen.queryByRole('region', { name: 'Your agent needs an answer' })).toBeNull();
});

test('the agent question is not offered once the task runs again', async () => {
  await open([taskResponse({ task: taskDetail({ status: 'running' }) })]);
  emit(prompt, ...ask(2, 'Which region?'), status(4, 'running', 'waiting_user'));
  await until(() => liveStatus() === 'The agent is working.');
  expect(screen.queryByRole('region', { name: 'Your agent needs an answer' })).toBeNull();
});

const STOPPABLE: Record<TaskStatus, boolean> = {
  queued: true,
  planning: true,
  running: true,
  waiting_user: true,
  finalizing: true,
  done: false,
  failed: false,
  cancelled: false,
};

for (const [taskStatus, stoppable] of Object.entries(STOPPABLE) as Array<[TaskStatus, boolean]>) {
  test(`Stop is ${stoppable ? 'offered' : 'not offered'} for a ${taskStatus} task`, async () => {
    await open([taskResponse({ task: taskDetail({ status: taskStatus }) })]);
    await screen.findByText('Find three suppliers', { selector: '.ui-msg-user' });
    expect(screen.queryByRole('button', { name: 'Stop' }) !== null).toBe(stoppable);
  });
}

test('a task waiting for an answer can be stopped', async () => {
  const { calls } = await open(
    [
      taskResponse({ task: taskDetail({ status: 'waiting_user' }) }),
      taskResponse({ task: taskDetail({ status: 'cancelled' }) }),
    ],
    { 'POST /api/tasks/task-1/cancel': json({ task: taskDetail({ status: 'cancelled' }) }) },
  );
  await userEvent.click(await screen.findByRole('button', { name: 'Stop' }));
  await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Stop task' }));
  await screen.findByText('Stopped');
  expect(calls.some(c => c.path === '/api/tasks/task-1/cancel')).toBe(true);
});

test('the Stop confirmation closes when the task ends on its own', async () => {
  await open([
    taskResponse({ task: taskDetail({ status: 'running' }) }),
    taskResponse({ task: taskDetail({ status: 'done', result: 'All set' }) }),
  ]);
  await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
  await screen.findByRole('alertdialog', { name: 'Stop the task?' });
  emit(prompt, status(2, 'running', 'done'));
  await screen.findByText('Task completed');
  await until(() => screen.queryByRole('alertdialog') === null);
});

test('the status region exists while the task loads, so the first status is announced', async () => {
  let release: (() => void) | undefined;
  const env = setup(
    {
      ...signedIn(),
      'GET /api/tasks/task-1': () =>
        new Promise<Response>(resolve => {
          release = () => resolve(json(taskResponse({ task: taskDetail({ status: 'running' }) })));
        }),
    },
    '/tasks/task-1',
  );
  env.view(<TaskScreen id="task-1" />);
  await screen.findByText('Loading the task');
  const region = document.getElementById('task-status');
  expect(region?.getAttribute('role')).toBe('status');
  expect(region?.textContent).toBe('');
  await until(() => release !== undefined);
  release!();
  await until(() => liveStatus() === 'The agent is working.');
  // Тот же узел: скринридер слышит изменение, а не новый регион.
  expect(document.getElementById('task-status')).toBe(region);
});

test('Try again shows that it is retrying', async () => {
  let reads = 0;
  let release: (() => void) | undefined;
  const env = setup(
    {
      ...signedIn(),
      'GET /api/tasks/task-1': () =>
        reads++ === 0
          ? json({ error: { code: 'internal', message: 'boom' } }, 500)
          : new Promise<Response>(resolve => {
              release = () => resolve(json(taskResponse({ task: taskDetail({ status: 'running' }) })));
            }),
    },
    '/tasks/task-1',
  );
  env.view(<TaskScreen id="task-1" />);
  await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
  expect(screen.getByRole('button', { name: 'Try again' }).getAttribute('aria-busy')).toBe('true');
  await until(() => release !== undefined);
  release!();
  await until(() => FakeEventSource.all.length === 1);
});

test('a task of another account is reported as not found', async () => {
  const env = setup(
    { ...signedIn(), 'GET /api/tasks/theirs': json({ error: { code: 'forbidden', message: 'not yours' } }, 403) },
    '/tasks/theirs',
  );
  env.view(<TaskScreen id="theirs" />);
  expect(await screen.findByText('Task not found')).toBeTruthy();
  expect(screen.queryByText('not yours')).toBeNull();
  expect(FakeEventSource.all).toHaveLength(0);
});

const RECONNECTING = 'Reconnecting to the live feed…';

test('a connection back within 5 s (the 15-minute close) shows no reconnecting notice', async () => {
  const timers = manualTimers();
  await open([taskResponse({ task: taskDetail({ status: 'running' }) })], {}, timers);
  await screen.findByText('Find three suppliers', { selector: '.ui-msg-user' });
  act(() => FakeEventSource.last.fail(0));
  expect(screen.queryByText(RECONNECTING)).toBeNull();
  act(() => FakeEventSource.last.open());
  act(() => timers.run());
  expect(screen.queryByText(RECONNECTING)).toBeNull();
});

test('a connection down for 5 s shows the reconnecting notice until the feed is back', async () => {
  const timers = manualTimers();
  await open([taskResponse({ task: taskDetail({ status: 'running' }) })], {}, timers);
  await screen.findByText('Find three suppliers', { selector: '.ui-msg-user' });
  act(() => FakeEventSource.last.fail(0));
  expect(screen.queryByText(RECONNECTING)).toBeNull();
  act(() => timers.run());
  expect(await screen.findByText(RECONNECTING)).toBeTruthy();
  act(() => FakeEventSource.last.open());
  await until(() => screen.queryByText(RECONNECTING) === null);
});

test.each([
  [404, 'not_found'],
  [403, 'forbidden'],
])('a task that is gone (%i) while shown says so instead of freezing', async (code, errorCode) => {
  let reads = 0;
  await open([], {
    'GET /api/tasks/task-1': () =>
      ++reads === 1
        ? json(taskResponse({ task: taskDetail({ status: 'running' }) }))
        : json({ error: { code: errorCode, message: 'secret detail' } }, code),
  });
  await screen.findByText('Find three suppliers', { selector: '.ui-msg-user' });
  emit(prompt, status(2, 'running', 'waiting_user'));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('This task is no longer available');
  expect(alert.textContent).not.toContain('secret detail');
  // Поток закрыт навсегда: «переподключение» не обещается.
  act(() => FakeEventSource.last.fail(2));
  expect(screen.queryByText(RECONNECTING)).toBeNull();
});
