import { expect, test } from 'bun:test';
import { effect } from '@preact/signals';
import { createAppState } from '../src/state/app.ts';
import { fakeFetch, json, me, taskSummary } from './fixtures.ts';

const t = (id: string) => taskSummary({ id, prompt: id });
/** Задача, созданная в 10:<minute>. */
const at = (id: string, minute: number) =>
  taskSummary({ id, prompt: id, createdAt: `2026-11-02T10:${String(minute).padStart(2, '0')}:00.000Z` });
const unauthorized = () => json({ error: { code: 'unauthorized', message: 'Sign in' } }, 401);

test('load() applies the profile theme and signs in; a 401 on /api/me signs out, a network failure is unreachable', async () => {
  const ok = createAppState({
    fetch: fakeFetch({
      'GET /api/config': json({ providers: ['github'], uploadMaxBytes: 10 }),
      'GET /api/me': json(me({ theme: 'light' })),
    }).fetch,
  });
  await ok.session.load();
  expect(ok.session.status.value).toBe('signed_in');
  expect(ok.session.config.value?.uploadMaxBytes).toBe(10);
  expect(document.documentElement.dataset.theme).toBe('light');

  const out = createAppState({ fetch: fakeFetch({ 'GET /api/me': unauthorized }).fetch });
  await out.session.load();
  expect(out.session.status.value).toBe('signed_out');

  const down = createAppState({
    fetch: () => {
      throw new TypeError('offline');
    },
  });
  await down.session.load();
  expect(down.session.status.value).toBe('unreachable');
});

test('parallel 401s move the session to signed_out exactly once', async () => {
  const state = createAppState({
    fetch: fakeFetch({ 'GET /api/me': json(me()), 'GET /api/tasks': unauthorized }).fetch,
  });
  await state.session.load();
  const seen: string[] = [];
  const stop = effect(() => void seen.push(state.session.status.value));
  await Promise.all([state.api.listTasks(), state.api.listTasks(), state.api.listTasks()].map(p => p.catch(() => {})));
  stop();
  expect(seen).toEqual(['signed_in', 'signed_out']);
  expect(state.session.me.value).toBeNull();
});

test('saveTheme shows the theme at once and rolls back when the profile cannot be saved', async () => {
  const state = createAppState({
    fetch: fakeFetch({
      'GET /api/me': json(me({ theme: 'dark' })),
      'PATCH /api/me': json({ error: { code: 'internal', message: 'boom' } }, 500),
    }).fetch,
  });
  await state.session.load();
  await expect(state.session.saveTheme('light')).rejects.toThrow();
  expect(document.documentElement.dataset.theme).toBe('dark');
  expect(state.session.me.value?.user.theme).toBe('dark');
});

test('more() does not duplicate tasks shifted by a task created while paging, and upsert puts new ones first', async () => {
  const state = createAppState({
    fetch: fakeFetch({
      'GET /api/tasks?limit=20': json({ tasks: [t('a'), t('b')], nextCursor: 'c1' }),
      'GET /api/tasks?limit=20&before=c1': json({ tasks: [t('b'), t('c')], nextCursor: null }),
    }).fetch,
  });
  await state.tasks.reload();
  await state.tasks.more();
  expect(state.tasks.items.value.map(x => x.id)).toEqual(['a', 'b', 'c']);
  expect(state.tasks.nextCursor.value).toBeNull();
  state.tasks.upsert({ ...t('new'), createdAt: '2026-11-02T11:00:00.000Z' });
  state.tasks.upsert({ ...t('b'), status: 'done' });
  expect(state.tasks.items.value.map(x => `${x.id}:${x.status}`)).toEqual([
    'new:running',
    'a:running',
    'b:done',
    'c:running',
  ]);
});

test('a 401 in the middle of work also forgets the task list of the session that ended', async () => {
  const state = createAppState({
    fetch: fakeFetch({
      'GET /api/me': json(me()),
      'GET /api/tasks': json({ tasks: [t('a'), t('b')], nextCursor: null }),
      'GET /api/tasks/a': unauthorized,
    }).fetch,
  });
  await state.session.load();
  await state.tasks.reload();
  expect(state.tasks.items.value).toHaveLength(2);
  await state.api.getTask('a').catch(() => {});
  expect(state.session.status.value).toBe('signed_out');
  expect(state.tasks.items.value).toEqual([]);
  expect(state.tasks.loaded.value).toBe(false);
});

test('touchSession that finds no session signs out and forgets the task list; a live one changes nothing', async () => {
  let alive = true;
  const state = createAppState({
    fetch: fakeFetch({
      'GET /api/me': json(me()),
      'GET /api/tasks': json({ tasks: [t('a')], nextCursor: null }),
      'GET /api/auth/get-session': () => json(alive ? { session: { id: 's1' }, user: { id: 'u1' } } : null),
    }).fetch,
  });
  await state.session.load();
  await state.tasks.reload();
  await state.touchSession();
  expect(state.session.status.value).toBe('signed_in');
  expect(state.tasks.items.value).toHaveLength(1);
  alive = false;
  await state.touchSession();
  expect(state.session.status.value).toBe('signed_out');
  expect(state.tasks.items.value).toEqual([]);
});

test('upsert of a task the sidebar does not know keeps the list in creation order', async () => {
  const state = createAppState({
    fetch: fakeFetch({
      'GET /api/tasks?limit=20': json({ tasks: [at('c', 30), at('b', 20)], nextCursor: 'cur' }),
      'GET /api/tasks?limit=20&before=cur': json({ tasks: [at('a', 10)], nextCursor: null }),
    }).fetch,
  });
  await state.tasks.reload();
  const ids = () => state.tasks.items.value.map(x => x.id);
  // Старая задача, открытая по ссылке, не прыгает наверх; она старше загруженных страниц — придёт с «Load more».
  state.tasks.upsert(at('a', 10));
  expect(ids()).toEqual(['c', 'b']);
  // Задача между загруженными встаёт на своё место.
  state.tasks.upsert(at('mid', 25));
  expect(ids()).toEqual(['c', 'mid', 'b']);
  // Новее первой — наверх.
  state.tasks.upsert(at('new', 40));
  expect(ids()).toEqual(['new', 'c', 'mid', 'b']);
  await state.tasks.more();
  expect(ids()).toEqual(['new', 'c', 'mid', 'b', 'a']);
  // Все страницы загружены: самая старая задача встаёт в конец.
  state.tasks.upsert(at('oldest', 5));
  expect(ids()).toEqual(['new', 'c', 'mid', 'b', 'a', 'oldest']);
});
