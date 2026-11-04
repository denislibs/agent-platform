import { afterEach, beforeEach, expect, setSystemTime, test } from 'bun:test';
import { act, render, screen, within } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { App, SESSION_TOUCH_MS } from '../src/app.tsx';
import type { StepDto } from '@agent/shared';
import { openTaskEvents } from '../src/api/events.ts';
import { resetPageFocus } from '../src/layout/page.ts';
import { safeReturnPath } from '../src/state/return-to.ts';
import { fakeFetch, json, noContent, status, step, taskSummary, toolStep } from './fixtures.ts';
import { signedIn, until } from './render.tsx';
import { FakeEventSource } from './sse.ts';

const unauthorized = json({ error: { code: 'unauthorized', message: 'sign in to continue' } }, 401);
const signedOutRoutes = { 'GET /api/config': json({ providers: [], uploadMaxBytes: 1 }), 'GET /api/me': unauthorized };

function start(routes: Parameters<typeof fakeFetch>[0], path: string) {
  history.replaceState(null, '', path);
  resetPageFocus();
  FakeEventSource.reset();
  const { fetch, calls } = fakeFetch(routes);
  const view = render(
    <App
      deps={{ fetch, openEvents: opts => openTaskEvents({ ...opts, createSource: url => new FakeEventSource(url) }) }}
    />,
  );
  return { calls, view };
}

const taskRoutes = (...ids: string[]) =>
  Object.fromEntries([
    ['GET /api/tasks', json({ tasks: ids.map(id => taskSummary({ id, prompt: `Task ${id}` })), nextCursor: null })],
    ...ids.map(id => [
      `GET /api/tasks/${id}`,
      json({
        task: { ...taskSummary({ id, prompt: `Task ${id}` }), result: null, tokensUsed: 0, lastSeq: 1, cycle: 1 },
        subtasks: [],
        files: [],
        preview: null,
      }),
    ]),
  ]);

beforeEach(() => localStorage.clear());

test('without a session every page leads to sign-in', async () => {
  start({ 'GET /api/config': json({ providers: [], uploadMaxBytes: 1 }), 'GET /api/me': unauthorized }, '/tasks/t1');
  await screen.findByRole('button', { name: 'Email me a sign-in link' });
  expect(location.pathname).toBe('/sign-in');
});

test('with a session /sign-in leads home', async () => {
  start(signedIn(), '/sign-in');
  await screen.findByRole('heading', { name: 'What should your agent do?' });
  expect(location.pathname).toBe('/');
});

test('after deleting the account the app shows sign-in without a return address', async () => {
  start({ ...signedIn(), 'DELETE /api/me': noContent }, '/settings');
  await userEvent.click(await screen.findByRole('button', { name: 'Delete account' }));
  const dialog = await screen.findByRole('alertdialog');
  await userEvent.type(within(dialog).getByRole('textbox'), 'ada@example.com');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Delete account' }));
  await screen.findByRole('button', { name: 'Email me a sign-in link' });
  expect(location.pathname + location.search).toBe('/sign-in');
});

test('an incomplete deletion shows sign-in with the explanation in a toast', async () => {
  const message = 'The deletion did not finish and you were signed out. Sign in and delete the account again.';
  start(
    { ...signedIn(), 'DELETE /api/me': json({ error: { code: 'deletion_incomplete', message } }, 409) },
    '/settings',
  );
  await userEvent.click(await screen.findByRole('button', { name: 'Delete account' }));
  const dialog = await screen.findByRole('alertdialog');
  await userEvent.type(within(dialog).getByRole('textbox'), 'ada@example.com');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Delete account' }));
  await screen.findByRole('button', { name: 'Email me a sign-in link' });
  expect(location.pathname + location.search).toBe('/sign-in');
  expect(await screen.findByText(message)).toBeTruthy();
});

test('a 401 in the middle of work ends the session and shows sign-in', async () => {
  start({ ...signedIn(), 'GET /api/tasks/t1': unauthorized }, '/tasks/t1');
  await screen.findByRole('button', { name: 'Email me a sign-in link' });
  expect(location.pathname).toBe('/sign-in');
});

test('Sign out leads to a clean sign-in page, without a return to the settings', async () => {
  start({ ...signedIn(), 'POST /api/auth/sign-out': json({ success: true }) }, '/settings');
  await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
  await screen.findByRole('button', { name: 'Email me a sign-in link' });
  expect(location.pathname + location.search).toBe('/sign-in');
});

test('a 401 on the settings page remembers it for after sign-in', async () => {
  start({ ...signedIn(), 'GET /api/tasks': unauthorized }, '/settings');
  await screen.findByRole('button', { name: 'Email me a sign-in link' });
  expect(location.pathname + location.search).toBe('/sign-in?next=%2Fsettings');
});

test('the task route opens the task screen; an unknown path is a not-found page inside the shell', async () => {
  start(
    {
      ...signedIn(),
      'GET /api/tasks': json({ tasks: [taskSummary({ id: 't1' })], nextCursor: null }),
      'GET /api/tasks/t1': json({
        task: { ...taskSummary({ id: 't1' }), result: null, tokensUsed: 0, lastSeq: 1, cycle: 1 },
        subtasks: [],
        files: [],
        preview: null,
      }),
    },
    '/nowhere',
  );
  await screen.findByText('Page not found');
  expect(screen.getByRole('navigation', { name: 'Tasks' })).toBeTruthy();
  await userEvent.click(await screen.findByRole('link', { name: /Find three suppliers/ }));
  await until(() => FakeEventSource.all.length > 0);
  expect(location.pathname).toBe('/tasks/t1');
  expect(FakeEventSource.last.url).toBe('/api/tasks/t1/events?after=0');
});

test('an unreachable server offers a retry', async () => {
  let fail = true;
  const { calls } = start(
    {
      ...signedIn(),
      'GET /api/me': () =>
        fail ? Promise.reject(new TypeError('Failed to fetch')) : (signedIn()['GET /api/me'] as Response),
    },
    '/',
  );
  await screen.findByText('Cannot reach the server');
  fail = false;
  await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByRole('heading', { name: 'What should your agent do?' });
  expect(calls.filter(c => c.path === '/api/me')).toHaveLength(2);
});

test('the intended page is remembered through sign-in and the email link leads back to it', async () => {
  const { calls } = start(
    { ...signedOutRoutes, 'POST /api/auth/sign-in/magic-link': json({ status: true }) },
    '/tasks/t1?tab=plan',
  );
  await screen.findByRole('button', { name: 'Email me a sign-in link' });
  expect(location.pathname + location.search).toBe('/sign-in?next=%2Ftasks%2Ft1%3Ftab%3Dplan');
  // Письмо ведёт обратно на нужную страницу, а не на главную.
  await userEvent.type(screen.getByRole('textbox', { name: 'Email address' }), 'ada@example.com{Enter}');
  await screen.findByRole('status');
  const send = calls.find(c => c.path === '/api/auth/sign-in/magic-link');
  expect(send?.body).toEqual({
    email: 'ada@example.com',
    callbackURL: '/tasks/t1?tab=plan',
    errorCallbackURL: '/sign-in',
  });
});

test('the home page is not remembered: sign-in stays clean', async () => {
  start(signedOutRoutes, '/');
  await screen.findByRole('button', { name: 'Email me a sign-in link' });
  expect(location.pathname + location.search).toBe('/sign-in');
});

test('a signed-in visit to sign-in returns to the intended page', async () => {
  start({ ...signedIn(), ...taskRoutes('t1') }, '/sign-in?next=%2Ftasks%2Ft1');
  await until(() => location.pathname === '/tasks/t1');
  await screen.findByRole('heading', { name: 'Task t1' });
});

test.each(['//evil.example', '/\\evil.example', 'https://evil.example/', 'javascript:alert(1)', '/api/me', '/sign-in'])(
  'a hostile return path %s leads home',
  async next => {
    start(signedIn(), `/sign-in?next=${encodeURIComponent(next)}`);
    await screen.findByRole('heading', { name: 'What should your agent do?' });
    expect(location.pathname).toBe('/');
    expect(location.search).toBe('');
  },
);

test('safeReturnPath accepts only same-origin relative paths', () => {
  expect(safeReturnPath('/tasks/t1')).toBe('/tasks/t1');
  expect(safeReturnPath('/settings?x=1#y')).toBe('/settings?x=1#y');
  for (const bad of [
    undefined,
    '',
    'tasks/t1',
    '//evil.example',
    '///evil.example',
    '/\\evil.example',
    '/\\\\evil.example',
    '/a\\b',
    '/\tevil',
    '/\n/evil.example',
    '/ /evil.example',
    'http://evil.example',
    'https://evil.example/tasks',
    'javascript:alert(1)',
    'data:text/html,x',
    '/api/files/f1',
    '/sign-in',
    '/sign-in?next=/',
    '/' + 'a'.repeat(2048),
  ])
    expect(safeReturnPath(bad)).toBeNull();
});

test('switching between tasks closes the stream of the previous one', async () => {
  start({ ...signedIn(), ...taskRoutes('t1', 't2') }, '/tasks/t1');
  await screen.findByRole('heading', { name: 'Task t1' });
  await until(() => FakeEventSource.all.length === 1);
  const first = FakeEventSource.last;
  await userEvent.click(await screen.findByRole('link', { name: /Task t2/ }));
  await screen.findByRole('heading', { name: 'Task t2' });
  await until(() => FakeEventSource.all.length === 2);
  expect(first.closed).toBe(true);
  expect(FakeEventSource.last.url).toBe('/api/tasks/t2/events?after=0');
  expect(FakeEventSource.last.closed).toBe(false);
});

/** Карточка задачи, ждущей ответа. */
const waiting = (id: string) =>
  json({
    task: {
      ...taskSummary({ id, prompt: `Task ${id}`, status: 'waiting_user' }),
      result: null,
      tokensUsed: 0,
      lastSeq: 6,
      cycle: 1,
    },
    subtasks: [],
    files: [],
    preview: null,
  });
/** Шаги из потока последней открытой задачи. */
const emit = (...steps: StepDto[]) =>
  act(() => {
    for (const s of steps) FakeEventSource.last.emit('step', s, String(s.seq));
  });
/** Лента задачи: запрос, шаги инструментов и вопрос агента. */
const flow = (...tools: StepDto[]) => [
  step(1, { type: 'message', role: 'user', text: 'Go' }, { agent: 'user', subtaskId: null }),
  ...tools,
  ...toolStep(
    4,
    'ask_user',
    { question: 'Which region?' },
    { control: { kind: 'ask_user', question: 'Which region?' } },
  ),
  status(6, 'running', 'waiting_user'),
];

test('a task opened from another one starts clean: steps open, no draft, live computer, previous stream closed', async () => {
  start(
    {
      ...signedIn(),
      ...taskRoutes('t1', 't2'),
      'GET /api/tasks/t1': waiting('t1'),
      'GET /api/tasks/t2': waiting('t2'),
    },
    '/tasks/t1',
  );
  await screen.findByRole('heading', { name: 'Task t1' });
  await until(() => FakeEventSource.all.length === 1);
  const first = FakeEventSource.last;
  emit(
    ...flow(
      ...toolStep(2, 'web_search', { query: 'steel' }, { output: 'one' }),
      ...toolStep(3, 'web_search', { query: 'iron' }, { output: 'two' }),
    ),
  );
  // В задаче t1 пользователь свернул шаги, набрал начало ответа и отмотал компьютер назад.
  await userEvent.click(await screen.findByRole('button', { name: /^Searched/ }));
  await userEvent.type(
    within(await screen.findByRole('region', { name: 'Your agent needs an answer' })).getByRole('textbox'),
    'half',
  );
  await userEvent.click(screen.getByRole('button', { name: 'Previous step' }));
  expect(screen.getByRole('button', { name: 'Jump to live' })).toBeTruthy();

  await userEvent.click(screen.getByRole('link', { name: /Task t2/ }));
  await screen.findByRole('heading', { name: 'Task t2' });
  await until(() => FakeEventSource.all.length === 2);
  expect(first.closed).toBe(true);
  expect(FakeEventSource.last.closed).toBe(false);
  emit(...flow(...toolStep(2, 'web_search', { query: 'copper' }, { output: 'three' })));
  const card = await screen.findByRole('region', { name: 'Your agent needs an answer' });
  expect((within(card).getByRole('textbox') as HTMLInputElement).value).toBe('');
  expect(screen.getByRole('button', { name: /^Searched/ }).getAttribute('aria-expanded')).toBe('true');
  expect(screen.queryByRole('button', { name: 'Jump to live' })).toBeNull();
});

test('not found sets the title and moves focus to the page', async () => {
  start(signedIn(), '/');
  await screen.findByRole('heading', { name: 'What should your agent do?' });
  await act(() => {
    history.pushState(null, '', '/nowhere');
    dispatchEvent(new PopStateEvent('popstate'));
  });
  await screen.findByText('Page not found');
  expect(document.title).toBe('Not found · agent');
  // Одна h1 страницы — сам «не найдено».
  expect(screen.getAllByRole('heading', { level: 1 }).map(h => h.textContent)).toEqual(['Page not found']);
});

// --- Продление cookie сессии ---

const touches = (calls: Array<{ path: string }>) => calls.filter(c => c.path === '/api/auth/get-session').length;
const session = json({ session: { id: 's1' }, user: { id: 'u1' } });

function tab(visibility: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  document.dispatchEvent(new Event('visibilitychange'));
}

/** Таймер продления подменяется ручным (остальные таймеры, в том числе `until`, остаются настоящими). */
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
let ticks = new Map<number, () => void>();
let nextTimer = 1_000_000;
const tick = () => {
  for (const fn of ticks.values()) fn();
};
const after = (ms: number) => setSystemTime(new Date(Date.now() + ms));

beforeEach(() => {
  ticks = new Map();
  globalThis.setInterval = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
    if (ms !== SESSION_TOUCH_MS) return (realSetInterval as (...a: unknown[]) => unknown)(fn, ms, ...rest);
    const id = nextTimer++;
    ticks.set(id, fn);
    return id;
  }) as typeof setInterval;
  globalThis.clearInterval = ((id: number) => {
    if (!ticks.delete(id)) realClearInterval(id);
  }) as typeof clearInterval;
});

afterEach(() => {
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
  setSystemTime();
  tab('visible');
});

test('the session cookie is refreshed every few minutes while the tab is visible', async () => {
  const { calls } = start({ ...signedIn(), 'GET /api/auth/get-session': session }, '/');
  await screen.findByRole('heading', { name: 'What should your agent do?' });
  await until(() => ticks.size === 1);
  expect(touches(calls)).toBe(0);
  tick();
  await until(() => touches(calls) === 1);
  // Скрытая вкладка не ходит на сервер.
  tab('hidden');
  tick();
  expect(touches(calls)).toBe(1);
});

test('returning to a tab that slept past the interval refreshes at once; a quick return does not', async () => {
  const { calls } = start({ ...signedIn(), 'GET /api/auth/get-session': session }, '/');
  await screen.findByRole('heading', { name: 'What should your agent do?' });
  await until(() => ticks.size === 1);
  tab('hidden');
  after(60_000);
  tab('visible');
  expect(touches(calls)).toBe(0);
  tab('hidden');
  after(SESSION_TOUCH_MS);
  tab('visible');
  await until(() => touches(calls) === 1);
});

test('a session that the server no longer knows sends the user to sign-in', async () => {
  const { calls } = start({ ...signedIn(), 'GET /api/auth/get-session': json(null) }, '/');
  await screen.findByRole('heading', { name: 'What should your agent do?' });
  await until(() => ticks.size === 1);
  tick();
  await screen.findByRole('button', { name: 'Email me a sign-in link' });
  expect(touches(calls)).toBe(1);
  expect(location.pathname).toBe('/sign-in');
});

test('a failed refresh is silent and stops with the app', async () => {
  const { calls, view } = start(
    { ...signedIn(), 'GET /api/auth/get-session': () => Promise.reject(new TypeError('Failed to fetch')) },
    '/',
  );
  await screen.findByRole('heading', { name: 'What should your agent do?' });
  await until(() => ticks.size === 1);
  tick();
  await until(() => touches(calls) === 1);
  expect(screen.getByRole('heading', { name: 'What should your agent do?' })).toBeTruthy();
  view.unmount();
  expect(ticks.size).toBe(0);
  tab('hidden');
  after(SESSION_TOUCH_MS * 3);
  tab('visible');
  expect(touches(calls)).toBe(1);
});

test('while signed out there is no refresh timer and no refresh on return', async () => {
  const { calls } = start({ ...signedOutRoutes, 'GET /api/auth/get-session': session }, '/');
  await screen.findByRole('button', { name: 'Email me a sign-in link' });
  expect(ticks.size).toBe(0);
  tab('hidden');
  after(SESSION_TOUCH_MS * 3);
  tab('visible');
  expect(touches(calls)).toBe(0);
});
