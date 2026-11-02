import { expect, test } from 'bun:test';
import { effect } from '@preact/signals';
import { createAppState } from '../src/state/app.ts';
import { fakeFetch, json, me, taskSummary } from './fixtures.ts';

const t = (id: string) => taskSummary({ id, prompt: id });
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
  state.tasks.upsert(t('new'));
  state.tasks.upsert({ ...t('b'), status: 'done' });
  expect(state.tasks.items.value.map(x => `${x.id}:${x.status}`)).toEqual([
    'new:running',
    'a:running',
    'b:done',
    'c:running',
  ]);
});
