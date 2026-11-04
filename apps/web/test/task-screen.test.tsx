import { afterEach, beforeEach, expect, test } from 'bun:test';
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

const user = { agent: 'user', subtaskId: null } as const;
const answerStep = (seq: number, text: string, files: string[] = []) =>
  step(seq, { type: 'message', role: 'assistant', text, kind: 'answer', files }, { agent: 'planner', subtaskId: null });
const doneTask = taskDetail({ status: 'done', result: 'First answer', lastSeq: 3 });
const reopened = taskDetail({
  status: 'planning',
  cycle: 2,
  lastSeq: 5,
  updatedAt: '2026-11-02T10:00:05.000Z',
});

/** Законченная задача с первым циклом в ленте; поток закрыт. */
async function finished(responses: Array<ReturnType<typeof taskResponse>>, extra: Parameters<typeof setup>[0] = {}) {
  const env = await open(responses, extra);
  emit(prompt, answerStep(2, 'First answer'), status(3, 'finalizing', 'done'));
  act(() => FakeEventSource.last.emit('end', { status: 'done' }));
  await screen.findByText('Task completed');
  return env;
}

const composer = () => screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;

test('a finished task takes a follow-up: the request shows at once, the stream reopens, focus goes to main', async () => {
  let card = doneTask;
  const { calls, state } = await finished([], {
    'GET /api/tasks/task-1': () => json(taskResponse({ task: card })),
    'POST /api/tasks/task-1/messages': () => {
      card = reopened;
      return json({ task: reopened }, 202);
    },
  });
  expect(composer().placeholder).toBe('Ask for changes or a follow-up');
  await userEvent.type(composer(), 'Add a date filter{Enter}');

  await screen.findByText('Add a date filter');
  expect(calls.find(c => c.method === 'POST')?.body).toEqual({ text: 'Add a date filter' });
  await until(() => FakeEventSource.last.url === '/api/tasks/task-1/events?after=3');
  // Итог прошлого цикла остаётся в ленте, а статус экрана — уже нового.
  expect(screen.getByText('First answer')).toBeTruthy();
  expect(screen.queryByText('Task completed')).toBeNull();
  expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
  expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
  await until(() => document.activeElement?.id === 'main');
  await until(() => state.tasks.items.value[0]?.status === 'planning');
});

test('every request stays in the feed with its answer and its files; the plan and the badge are of the last cycle', async () => {
  const report = fileDto({ id: 'f1', path: 'outputs/report.md' });
  const chart = fileDto({ id: 'f2', path: 'outputs/chart.png' });
  await open([
    taskResponse({
      task: taskDetail({ status: 'done', result: 'Second answer', cycle: 2, lastSeq: 8 }),
      files: [report, chart],
      subtasks: [
        subtask(0, { goal: 'Old plan', status: 'accepted' }),
        subtask(1, { goal: 'New plan', status: 'accepted', cycle: 2 }),
      ],
    }),
  ]);
  emit(
    prompt,
    answerStep(2, 'First answer', ['outputs/report.md']),
    status(3, 'finalizing', 'done'),
    status(4, 'done', 'planning'),
    step(5, { type: 'message', role: 'user', text: 'Add a chart' }, user),
    answerStep(6, 'Second answer', ['outputs/report.md', 'outputs/chart.png']),
    status(7, 'finalizing', 'done'),
  );
  await screen.findByText('Second answer');
  const main = document.body.textContent ?? '';
  const order = ['Find three suppliers', 'First answer', 'Add a chart', 'Second answer'].map(t => main.indexOf(t));
  expect(order).toEqual(order.toSorted((a, b) => a - b));
  expect(order.every(at => at >= 0)).toBe(true);
  expect(screen.getAllByRole('link', { name: /^report\.md/ })).toHaveLength(2);
  expect(screen.getAllByRole('link', { name: /^chart\.png/ })).toHaveLength(1);
  expect(screen.getAllByText('Task completed')).toHaveLength(1);
  expect(screen.getByText('New plan')).toBeTruthy();
  expect(screen.queryByText('Old plan')).toBeNull();
});

test('an earlier cycle that did not reach an answer says how it ended', async () => {
  await open([taskResponse({ task: taskDetail({ status: 'running', cycle: 3, lastSeq: 9 }) })]);
  emit(
    prompt,
    status(2, 'running', 'failed', 'the sandbox crashed'),
    status(3, 'failed', 'planning'),
    step(4, { type: 'message', role: 'user', text: 'Try again' }, user),
    status(5, 'planning', 'cancelled'),
    status(6, 'cancelled', 'planning'),
    step(7, { type: 'message', role: 'user', text: 'And again' }, user),
  );
  await screen.findByText('And again');
  expect(screen.getByText('the sandbox crashed')).toBeTruthy();
  expect(screen.getByText('Try again')).toBeTruthy();
  expect(screen.getByText('Stopped')).toBeTruthy();
});

test.each([
  ['insufficient_credits', 402, 'not enough credits to start a task'],
  ['too_many_active_tasks', 429, 'at most 2 active tasks per user'],
] as const)('%s keeps the text in the field and says why', async (code, httpStatus, message) => {
  await finished([taskResponse({ task: doneTask })], {
    'POST /api/tasks/task-1/messages': json({ error: { code, message } }, httpStatus),
  });
  await userEvent.type(composer(), 'More{Enter}');
  await screen.findByText('The message was not sent');
  screen.getByText(message);
  expect(composer().value).toBe('More');
  expect(composer().disabled).toBe(false);
  expect(screen.getByText('Task completed')).toBeTruthy();
});

test('a task that changed meanwhile: 409 says so and the screen catches up', async () => {
  let card = doneTask;
  await finished([], {
    'GET /api/tasks/task-1': () => json(taskResponse({ task: card })),
    'POST /api/tasks/task-1/messages': () => {
      card = reopened;
      return json({ error: { code: 'conflict', message: 'the task is not waiting for an answer' } }, 409);
    },
  });
  await userEvent.type(composer(), 'More{Enter}');
  await screen.findByText('The task has changed');
  await screen.findByRole('button', { name: 'Stop' });
  await until(() => FakeEventSource.last.url === '/api/tasks/task-1/events?after=3');
});

/** happy-dom не умеет прокручивать: запоминаем, к чему и как просили. */
const scrolled: Array<{ text: string | null; options: unknown }> = [];
const realScroll = Element.prototype.scrollIntoView;
const realMatchMedia = window.matchMedia;
beforeEach(() => {
  scrolled.length = 0;
  Element.prototype.scrollIntoView = function (this: Element, options?: boolean | ScrollIntoViewOptions) {
    scrolled.push({ text: this.textContent, options });
  };
});
afterEach(() => {
  Element.prototype.scrollIntoView = realScroll;
  window.matchMedia = realMatchMedia;
});

test('two Enters in one tick send once; a refusal keeps the draft and returns focus to the field', async () => {
  const { calls } = await finished([taskResponse({ task: doneTask })], {
    'POST /api/tasks/task-1/messages': json(
      { error: { code: 'insufficient_credits', message: 'not enough credits to start a task' } },
      402,
    ),
  });
  await userEvent.type(composer(), 'More');
  act(() => {
    fireEvent.keyDown(composer(), { key: 'Enter' });
    fireEvent.keyDown(composer(), { key: 'Enter' });
  });
  // Браузер снимает фокус с поля, которое стало недоступным на время отправки.
  document.getElementById('main')?.focus();
  expect(document.activeElement?.id).toBe('main');
  await screen.findByText('The message was not sent');
  await until(() => document.activeElement === composer());
  expect(calls.filter(c => c.method === 'POST')).toHaveLength(1);
  expect(composer().value).toBe('More');
});

test('a new cycle scrolls its request into view, once; smooth unless the user prefers reduced motion', async () => {
  let card = doneTask;
  await finished([], {
    'GET /api/tasks/task-1': () => json(taskResponse({ task: card })),
    'POST /api/tasks/task-1/messages': () => {
      card = reopened;
      return json({ task: reopened }, 202);
    },
  });
  expect(scrolled).toHaveLength(0);
  await userEvent.type(composer(), 'Add a date filter{Enter}');
  await until(() => scrolled.length === 1);
  await until(() => FakeEventSource.last.url === '/api/tasks/task-1/events?after=3');
  expect(scrolled).toEqual([{ text: 'Add a date filter', options: { block: 'start', behavior: 'smooth' } }]);
});

test('reduced motion scrolls to the new request without animation', async () => {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('prefers-reduced-motion'),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  let card = doneTask;
  await finished([], {
    'GET /api/tasks/task-1': () => json(taskResponse({ task: card })),
    'POST /api/tasks/task-1/messages': () => {
      card = reopened;
      return json({ task: reopened }, 202);
    },
  });
  await userEvent.type(composer(), 'Add a date filter{Enter}');
  await until(() => scrolled.length === 1);
  expect(scrolled[0]?.options).toEqual({ block: 'start', behavior: 'auto' });
});

test('opening a task that already has several cycles does not scroll', async () => {
  await open([taskResponse({ task: taskDetail({ status: 'done', result: 'Second answer', cycle: 2, lastSeq: 8 }) })]);
  emit(
    prompt,
    answerStep(2, 'First answer'),
    status(3, 'finalizing', 'done'),
    status(4, 'done', 'planning'),
    step(5, { type: 'message', role: 'user', text: 'Add a chart' }, user),
    answerStep(6, 'Second answer'),
    status(7, 'finalizing', 'done'),
  );
  await screen.findByText('Second answer');
  expect(scrolled).toHaveLength(0);
});

test('a task reopened from another tab: the card comes before the feed; the scroll waits for the new cycle', async () => {
  let card = taskDetail({ status: 'done', result: 'First answer', lastSeq: 5 });
  await open([], {
    'GET /api/tasks/task-1': () => json(taskResponse({ task: card })),
    // Другая вкладка продолжила задачу раньше: отказ перечитывает карточку, она уже второго цикла.
    'POST /api/tasks/task-1/messages': () => {
      card = taskDetail({ status: 'running', cycle: 2, lastSeq: 8 });
      return json({ error: { code: 'conflict', message: 'the task is not waiting for an answer' } }, 409);
    },
  });
  emit(
    prompt,
    ...toolStep(2, 'web_search', { query: 'a' }),
    answerStep(4, 'First answer'),
    status(5, 'finalizing', 'done'),
  );
  act(() => FakeEventSource.last.emit('end', { status: 'done' }));
  const earlier = await screen.findByRole('button', { name: 'Searched 1 query' });
  expect(earlier.getAttribute('aria-expanded')).toBe('false');
  await userEvent.type(composer(), 'More{Enter}');
  // Карточка уже второго цикла, а его шагов в ленте ещё нет: прокручивать некуда.
  await until(() => FakeEventSource.last.url === '/api/tasks/task-1/events?after=5');
  await screen.findByRole('button', { name: 'Stop' });
  expect(scrolled).toHaveLength(0);

  // Лента догнала карточку (поток открылся заново): запрос нового цикла на экране, шаги раскрыты.
  emit(
    status(6, 'done', 'planning'),
    step(7, { type: 'message', role: 'user', text: 'Add a chart' }, user),
    ...toolStep(8, 'web_search', { query: 'b' }),
  );
  await until(() => scrolled.length === 1);
  expect(scrolled[0]?.text).toBe('Add a chart');
  const current = await screen.findByRole('button', { name: '1 steps' });
  expect(current.getAttribute('aria-expanded')).toBe('true');
});

test.each(['failed', 'cancelled'] as const)('a %s task also offers the composer', async taskStatus => {
  await open([taskResponse({ task: taskDetail({ status: taskStatus }) })]);
  expect(composer().disabled).toBe(false);
});

test('the stop dialog says the task can be continued', async () => {
  await open([taskResponse({ task: taskDetail({ status: 'running' }) })]);
  await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
  const dialog = await screen.findByRole('alertdialog');
  within(dialog).getByText('The agent stops where it is. You can send it a new message to continue.');
});

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

test('undelivered files replace the success badge with a warning', async () => {
  await open([
    taskResponse({
      task: taskDetail({ status: 'done', partial: true, stopReason: 'missing_files', result: 'Built the app' }),
    }),
  ]);
  expect(await screen.findByText('Some files were not saved')).toBeTruthy();
  expect(screen.getByText('Finished without all files')).toBeTruthy();
  expect(screen.queryByText('Task completed')).toBeNull();
  expect(screen.queryByText(/stopped early/)).toBeNull();
  expect(screen.getByText('Built the app')).toBeTruthy();
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
  expect(screen.getAllByRole('heading', { level: 1 }).map(h => h.textContent)).toEqual(['Task']);
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
  expect(screen.getAllByRole('heading', { level: 1 }).map(h => h.textContent)).toEqual(['Task not found']);
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
  expect(screen.getAllByRole('heading', { level: 1 }).map(h => h.textContent)).toEqual(['Task']);
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

const PREVIEW = { url: 'https://site.preview.test/' };
const panel = () => screen.getByRole('region', { name: "Agent's computer" });
const switchTo = (name: string) => within(panel()).getByRole('button', { name });
const pressed = (name: string) => switchTo(name).getAttribute('aria-pressed');
const siteFile = (createdAt = '2026-11-02T10:00:00.000Z') =>
  fileDto({ path: 'outputs/index.html', mime: 'text/html', createdAt });
const donePreview = (overrides: Partial<ReturnType<typeof taskDetail>> = {}, files = [siteFile()]) =>
  taskResponse({ task: { ...doneTask, ...overrides }, files, preview: PREVIEW });

/** Экран задачи, чья карточка — текущее значение card; поток открыт, поэтому шаг status перечитывает карточку. */
async function openCard(first: ReturnType<typeof taskResponse>) {
  let card = first;
  const env = await open([first], { 'GET /api/tasks/task-1': () => json(card) });
  const reads = () => env.calls.filter(c => c.path === '/api/tasks/task-1').length;
  let seq = 100;
  /** Новая карточка: экран перечитал её и отрисовал. */
  const update = async (next: ReturnType<typeof taskResponse>) => {
    card = next;
    const before = reads();
    emit(status((seq += 1), 'running', 'finalizing'));
    await until(() => reads() > before);
    // Ответ чтения и отрисовка идут после вызова fetch.
    await act(() => new Promise(resolve => setTimeout(resolve, 0)));
  };
  await until(() => document.title === 'Find three suppliers · agent');
  return { update };
}

test('without a preview there is no switch and no frame', async () => {
  await openCard(taskResponse({ task: doneTask }));
  expect(within(panel()).queryByRole('button', { name: 'Preview' })).toBeNull();
  expect(screen.queryByTitle('Site preview')).toBeNull();
  expect(screen.queryByRole('link', { name: 'Open preview' })).toBeNull();
});

test('a finished task with a preview opens on it; the links open a new tab without an opener', async () => {
  await openCard(donePreview());
  const frame = await screen.findByTitle('Site preview');
  expect(frame.getAttribute('src')).toBe(PREVIEW.url);
  expect(pressed('Preview')).toBe('true');
  // Над сайтом агента всегда строка панели: чей он и что в него нельзя вводить.
  expect(
    within(panel()).getByText(/Built by the agent\. Not part of this app\. Do not enter passwords\./),
  ).toBeTruthy();
  const newTab = within(panel()).getByRole('link', { name: 'Open in new tab' });
  expect(newTab.getAttribute('href')).toBe(PREVIEW.url);
  expect(newTab.getAttribute('rel')).toBe('noopener noreferrer');
  // Панель скрыта на средней ширине экрана: ссылка в ответе остаётся доступной.
  expect(screen.getByRole('link', { name: 'Open preview' }).getAttribute('rel')).toBe('noopener noreferrer');
});

test('the switch moves between the site and the activity, and a reread does not move it back', async () => {
  const { update } = await openCard(donePreview());
  await userEvent.click(await screen.findByRole('button', { name: 'Activity' }));
  expect(screen.queryByTitle('Site preview')).toBeNull();
  expect(within(panel()).queryByText(/Built by the agent/)).toBeNull();
  expect(pressed('Activity')).toBe('true');
  await update(donePreview());
  expect(pressed('Activity')).toBe('true');
  await userEvent.click(switchTo('Preview'));
  expect(screen.getByTitle('Site preview')).toBeTruthy();
});

test('during a run the panel stays on Activity; when the cycle finishes it opens the preview by itself', async () => {
  const running = taskResponse({
    task: taskDetail({ status: 'running', cycle: 2 }),
    files: [siteFile()],
    preview: PREVIEW,
  });
  const { update } = await openCard(running);
  // Сайт прошлого цикла можно открыть, но сам экран на него не переходит.
  expect(pressed('Activity')).toBe('true');
  expect(screen.queryByTitle('Site preview')).toBeNull();
  await update(running);
  expect(pressed('Activity')).toBe('true');
  await update(donePreview({ cycle: 2 }, [siteFile('2026-11-02T10:05:00.000Z')]));
  expect(screen.getByTitle('Site preview')).toBeTruthy();
  expect(pressed('Preview')).toBe('true');
});

test('a preview that appears during the run does not interrupt it', async () => {
  const { update } = await openCard(taskResponse({ task: taskDetail({ status: 'running' }) }));
  expect(within(panel()).queryByRole('button', { name: 'Preview' })).toBeNull();
  await update(taskResponse({ task: taskDetail({ status: 'finalizing' }), files: [siteFile()], preview: PREVIEW }));
  expect(pressed('Activity')).toBe('true');
  expect(screen.queryByTitle('Site preview')).toBeNull();
});

test('a new cycle goes back to Activity', async () => {
  const { update } = await openCard(donePreview());
  await screen.findByTitle('Site preview');
  await update(taskResponse({ task: reopened, files: [siteFile()], preview: PREVIEW }));
  expect(screen.queryByTitle('Site preview')).toBeNull();
  expect(pressed('Activity')).toBe('true');
});

test('the frame reloads when the delivered files or the cycle change, and only then', async () => {
  const { update } = await openCard(donePreview());
  const later = '2026-11-02T10:05:00.000Z';
  const first = await screen.findByTitle('Site preview');
  await update(donePreview());
  expect(screen.getByTitle('Site preview')).toBe(first);
  await update(donePreview({}, [siteFile(later)]));
  const second = screen.getByTitle('Site preview');
  expect(second).not.toBe(first);
  await update(donePreview({ cycle: 2 }, [siteFile(later)]));
  expect(screen.getByTitle('Site preview')).not.toBe(second);
});

test('a preview that goes away takes the switch with it', async () => {
  const { update } = await openCard(donePreview());
  await screen.findByTitle('Site preview');
  await update(taskResponse({ task: doneTask }));
  expect(screen.queryByTitle('Site preview')).toBeNull();
  expect(within(panel()).queryByRole('button', { name: 'Preview' })).toBeNull();
});

test('a preview with an address that is not absolute http(s) is treated as no preview', async () => {
  await openCard(taskResponse({ task: doneTask, files: [siteFile()], preview: { url: '/' } }));
  expect(within(panel()).queryByRole('button', { name: 'Preview' })).toBeNull();
  expect(screen.queryByTitle('Site preview')).toBeNull();
  expect(screen.queryByRole('link', { name: 'Open preview' })).toBeNull();
  expect(within(panel()).queryByRole('link', { name: 'Open in new tab' })).toBeNull();
});

test.each(['failed', 'cancelled'] as const)(
  'a %s task with a preview opens it in the panel and keeps the link in the answer',
  async taskStatus => {
    await openCard(donePreview({ status: taskStatus }));
    await screen.findByTitle('Site preview');
    expect(pressed('Preview')).toBe('true');
    expect(screen.getByRole('link', { name: 'Open preview' }).getAttribute('rel')).toBe('noopener noreferrer');
  },
);

test('a running task with a preview has no link in the answer', async () => {
  await openCard(taskResponse({ task: taskDetail({ status: 'running' }), files: [siteFile()], preview: PREVIEW }));
  expect(screen.queryByRole('link', { name: 'Open preview' })).toBeNull();
});
