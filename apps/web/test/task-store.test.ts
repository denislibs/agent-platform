import { beforeEach, expect, test } from 'bun:test';
import { createApi } from '../src/api/client.ts';
import { openTaskEvents } from '../src/api/events.ts';
import { createTaskStore } from '../src/state/task.ts';
import { fakeFetch, json, status, step, subtask, taskDetail, taskResponse, toolStep } from './fixtures.ts';
import { FakeEventSource, manualTimers } from './sse.ts';

beforeEach(() => FakeEventSource.reset());

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function setup(responses: Array<ReturnType<typeof taskResponse>>) {
  let reads = 0;
  const { fetch, calls } = fakeFetch({
    'GET /api/tasks/task-1': () =>
      responses.length === 0
        ? json({ error: { code: 'not_found', message: 'task not found' } }, 404)
        : json(responses[Math.min(reads++, responses.length - 1)]),
    'POST /api/tasks/task-1/messages': json({ task: taskDetail({ status: 'waiting_user', lastSeq: 9 }) }, 202),
    'POST /api/tasks/task-1/cancel': json({ task: taskDetail({ status: 'cancelled' }) }),
  });
  const store = createTaskStore(
    {
      api: createApi({ fetch }),
      openEvents: opts => openTaskEvents({ ...opts, createSource: url => new FakeEventSource(url) }),
    },
    'task-1',
  );
  return { store, calls, reads: () => reads };
}

test('start loads the card, then streams every step from the beginning', async () => {
  const { store } = setup([taskResponse({ subtasks: [subtask(0)] })]);
  await store.start();
  expect(store.task.value?.id).toBe('task-1');
  expect(store.subtasks.value).toHaveLength(1);
  expect(FakeEventSource.last.url).toBe('/api/tasks/task-1/events?after=0');
  FakeEventSource.last.emit('step', step(1, { type: 'message', role: 'user', text: 'Find three suppliers' }));
  expect(store.steps.value.map(s => s.seq)).toEqual([1]);
});

test('a status step or a plan signal re-reads the card; ordinary tool output does not', async () => {
  const { store, reads } = setup([
    taskResponse(),
    taskResponse({ task: taskDetail({ status: 'running' }), subtasks: [subtask(0, { status: 'running' })] }),
  ]);
  await store.start();
  expect(reads()).toBe(1);
  for (const s of toolStep(2, 'shell', { cmd: 'ls' }, { output: 'a.csv' })) FakeEventSource.last.emit('step', s);
  await tick();
  expect(reads()).toBe(1);
  for (const s of toolStep(4, 'create_plan', {}, { control: { kind: 'create_plan', subtasks: [] } }))
    FakeEventSource.last.emit('step', s);
  FakeEventSource.last.emit('step', status(6, 'planning', 'running'));
  await tick();
  await tick();
  // Два сигнала подряд: одно чтение идёт, второе схлопнуто в одно следующее.
  expect(reads()).toBe(3);
  expect(store.subtasks.value[0]?.status).toBe('running');
});

test('end re-reads the card for the result and the output files', async () => {
  const { store, reads } = setup([
    taskResponse(),
    taskResponse({ task: taskDetail({ status: 'done', result: 'Here you go' }) }),
  ]);
  await store.start();
  FakeEventSource.last.emit('end', { status: 'done' });
  await tick();
  expect(reads()).toBe(2);
  expect(store.task.value?.result).toBe('Here you go');
  expect(store.finished).toBe(true);
});

test('reply sends the pause seq; cancel stores the cancelled task and re-reads the card', async () => {
  const { store, calls } = setup([taskResponse(), taskResponse({ task: taskDetail({ status: 'cancelled' }) })]);
  await store.start();
  await store.reply('EU only', 8);
  expect(calls.find(c => c.method === 'POST')?.body).toEqual({ text: 'EU only', questionSeq: 8 });
  await store.cancel();
  expect(store.task.value?.status).toBe('cancelled');
});

test('an unknown task ends in an error and opens no stream', async () => {
  const { store } = setup([]);
  await store.start();
  expect(store.error.value?.code).toBe('not_found');
  expect(FakeEventSource.all).toHaveLength(0);
});

test('a lost connection re-reads the card (it also re-checks the session)', async () => {
  const { store, reads } = setup([taskResponse()]);
  await store.start();
  FakeEventSource.last.fail(0);
  await tick();
  expect(store.connected.value).toBe(false);
  expect(reads()).toBe(2);
});

test('dispose closes the stream', async () => {
  const { store } = setup([taskResponse()]);
  await store.start();
  store.dispose();
  expect(FakeEventSource.last.closed).toBe(true);
});

/** Стор с ручными таймерами и сменным ответом GET задачи: для потерь связи, отказов и уборки. */
function setupLive() {
  const timers = manualTimers();
  let reply = json(taskResponse());
  let unauthorized = 0;
  let reads = 0;
  const { fetch } = fakeFetch({
    'GET /api/tasks/task-1': () => {
      reads++;
      return reply.clone();
    },
  });
  const store = createTaskStore(
    {
      api: createApi({ fetch, onUnauthorized: () => unauthorized++ }),
      openEvents: opts => openTaskEvents({ ...opts, ...timers, createSource: url => new FakeEventSource(url) }),
    },
    'task-1',
  );
  return {
    store,
    timers,
    reads: () => reads,
    unauthorized: () => unauthorized,
    answer: (res: Response) => void (reply = res),
  };
}

test('a reconnect refused because the session expired stops the stream and asks to sign in', async () => {
  const { store, timers, answer, unauthorized } = setupLive();
  await store.start();
  answer(json({ error: { code: 'unauthorized', message: 'sign in' } }, 401));
  FakeEventSource.last.fail(2);
  await tick();
  expect(unauthorized()).toBe(1);
  expect(store.error.value?.status).toBe(401);
  expect(FakeEventSource.last.closed).toBe(true);
  expect(timers.delays()).toEqual([]);
  timers.run();
  expect(FakeEventSource.all).toHaveLength(1);
});

test('a task that is gone (404) stops the stream for good', async () => {
  const { store, timers, answer } = setupLive();
  await store.start();
  answer(json({ error: { code: 'not_found', message: 'task not found' } }, 404));
  FakeEventSource.last.emit('stream_error');
  await tick();
  expect(store.error.value?.code).toBe('not_found');
  timers.run();
  expect(FakeEventSource.all).toHaveLength(1);
});

test('a later refusal while already disconnected still re-checks the session', async () => {
  const { store, timers, answer, unauthorized, reads } = setupLive();
  await store.start();
  FakeEventSource.last.fail(2);
  await tick();
  expect(reads()).toBe(2);
  answer(json({ error: { code: 'unauthorized', message: 'sign in' } }, 401));
  timers.run();
  FakeEventSource.last.fail(2);
  await tick();
  expect(unauthorized()).toBe(1);
  timers.run();
  expect(FakeEventSource.all).toHaveLength(2);
});

test('a network failure while re-checking keeps the stream retrying', async () => {
  const { store, timers, answer } = setupLive();
  await store.start();
  answer(json({ error: { code: 'internal', message: 'boom' } }, 500));
  FakeEventSource.last.fail(2);
  await tick();
  expect(store.error.value?.code).toBe('internal');
  timers.run();
  expect(FakeEventSource.all).toHaveLength(2);
});

test('dispose cancels a pending reconnect', async () => {
  const { store, timers } = setupLive();
  await store.start();
  FakeEventSource.last.emit('stream_error');
  store.dispose();
  timers.run();
  expect(FakeEventSource.all).toHaveLength(1);
});

test('dispose before the card arrives opens no stream', async () => {
  const { store } = setupLive();
  const started = store.start();
  store.dispose();
  await started;
  expect(FakeEventSource.all).toHaveLength(0);
});

test('steps are kept by seq: duplicates dropped, a late one slotted in order, one sent while opening kept', async () => {
  const { fetch } = fakeFetch({ 'GET /api/tasks/task-1': () => json(taskResponse()) });
  let push: ((seq: number) => void) | undefined;
  const store = createTaskStore(
    {
      api: createApi({ fetch }),
      openEvents: opts => {
        push = seq => opts.onStep(step(seq, { type: 'message', role: 'assistant', text: `m${seq}` }));
        // Шаг приходит синхронно, ещё до того как start() вернул управление.
        push(1);
        return { close: () => undefined };
      },
    },
    'task-1',
  );
  await store.start();
  for (const seq of [3, 3, 2, 1, 4]) push?.(seq);
  expect(store.steps.value.map(s => s.seq)).toEqual([1, 2, 3, 4]);
});
