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

test('a follow-up shows its request at once and streams on from the last step received', async () => {
  const done = taskDetail({ status: 'done', result: 'First', lastSeq: 3 });
  const reopened = taskDetail({ status: 'planning', cycle: 2, lastSeq: 5, updatedAt: '2026-11-02T12:00:00.000Z' });
  const { fetch, calls } = fakeFetch({
    'GET /api/tasks/task-1': json(taskResponse({ task: done })),
    'POST /api/tasks/task-1/messages': json({ task: reopened }, 202),
  });
  const store = createTaskStore(
    {
      api: createApi({ fetch }),
      openEvents: opts => openTaskEvents({ ...opts, createSource: url => new FakeEventSource(url) }),
    },
    'task-1',
  );
  await store.start();
  const first = FakeEventSource.last;
  first.emit('step', step(1, { type: 'message', role: 'user', text: 'Find' }, { agent: 'user', subtaskId: null }));
  first.emit('step', status(3, 'finalizing', 'done'));
  first.emit('end', { status: 'done' });
  await tick();

  const reading = store.followUp('Now change it');
  await reading;

  expect(calls.find(c => c.method === 'POST')?.body).toEqual({ text: 'Now change it' });
  expect(store.task.value).toMatchObject({ status: 'planning', cycle: 2 });
  expect(store.steps.value.map(s => s.seq)).toEqual([1, 3, 4, 5]);
  expect(store.steps.value.at(-2)?.payload).toEqual({ type: 'status', from: 'done', to: 'planning' });
  expect(store.steps.value.at(-1)).toMatchObject({
    agent: 'user',
    createdAt: '2026-11-02T12:00:00.000Z',
    payload: { type: 'message', role: 'user', text: 'Now change it' },
  });
  expect(FakeEventSource.last).not.toBe(first);
  expect(FakeEventSource.last.url).toBe('/api/tasks/task-1/events?after=3');

  // Поток повторяет эти шаги: дублей в ленте нет, а новые идут дальше.
  FakeEventSource.last.emit('step', status(4, 'done', 'planning'));
  FakeEventSource.last.emit(
    'step',
    step(5, { type: 'message', role: 'user', text: 'Now change it' }, { agent: 'user' }),
  );
  FakeEventSource.last.emit('step', status(6, 'planning', 'running'));
  expect(store.steps.value.map(s => s.seq)).toEqual([1, 3, 4, 5, 6]);
});

test('a refused follow-up changes nothing: the error goes to the caller, the stream stays closed', async () => {
  const { fetch } = fakeFetch({
    'GET /api/tasks/task-1': json(taskResponse({ task: taskDetail({ status: 'done' }) })),
    'POST /api/tasks/task-1/messages': json({ error: { code: 'insufficient_credits', message: 'no credits' } }, 402),
  });
  const store = createTaskStore(
    {
      api: createApi({ fetch }),
      openEvents: opts => openTaskEvents({ ...opts, createSource: url => new FakeEventSource(url) }),
    },
    'task-1',
  );
  await store.start();
  FakeEventSource.last.emit('end', { status: 'done' });
  await tick();
  const sources = FakeEventSource.all.length;
  await expect(store.followUp('More')).rejects.toMatchObject({ code: 'insufficient_credits' });
  expect(store.task.value?.status).toBe('done');
  expect(store.steps.value).toEqual([]);
  expect(FakeEventSource.all).toHaveLength(sources);
});

test('a task continued elsewhere: a re-read that finds it working opens the stream again', async () => {
  let card = taskDetail({ status: 'done' });
  const { fetch } = fakeFetch({ 'GET /api/tasks/task-1': () => json(taskResponse({ task: card })) });
  const store = createTaskStore(
    {
      api: createApi({ fetch }),
      openEvents: opts => openTaskEvents({ ...opts, createSource: url => new FakeEventSource(url) }),
    },
    'task-1',
  );
  await store.start();
  const first = FakeEventSource.last;
  first.emit('step', status(3, 'finalizing', 'done'));
  first.emit('end', { status: 'done' });
  await tick();
  await tick();
  expect(FakeEventSource.all).toHaveLength(1);
  card = taskDetail({ status: 'planning', cycle: 2 });
  await store.refresh();
  expect(FakeEventSource.all).toHaveLength(2);
  expect(FakeEventSource.last.url).toBe('/api/tasks/task-1/events?after=3');
});

function followUpSetup(overrides: {
  post?: () => Response | Promise<Response>;
  card?: () => ReturnType<typeof taskDetail>;
}) {
  const card = overrides.card ?? (() => taskDetail({ status: 'done', lastSeq: 3 }));
  const { fetch, calls } = fakeFetch({
    'GET /api/tasks/task-1': () => json(taskResponse({ task: card() })),
    'POST /api/tasks/task-1/messages': () => (overrides.post ?? (() => json({ task: card() }, 202)))(),
  });
  const store = createTaskStore(
    {
      api: createApi({ fetch }),
      openEvents: opts => openTaskEvents({ ...opts, createSource: url => new FakeEventSource(url) }),
    },
    'task-1',
  );
  return { store, calls };
}

function deferred() {
  let resolve!: (res: Response) => void;
  const promise = new Promise<Response>(r => (resolve = r));
  return { promise, resolve };
}

async function endedAt(store: ReturnType<typeof createTaskStore>, seq: number): Promise<void> {
  await store.start();
  FakeEventSource.last.emit('step', status(seq, 'finalizing', 'done'));
  FakeEventSource.last.emit('end', { status: 'done' });
  await tick();
  await tick();
}

test('leaving the screen during a follow-up opens no stream', async () => {
  const pending = deferred();
  const { store } = followUpSetup({ post: () => pending.promise });
  await endedAt(store, 3);
  const sources = FakeEventSource.all.length;
  const sending = store.followUp('More');
  store.dispose();
  pending.resolve(json({ task: taskDetail({ status: 'planning', cycle: 2, lastSeq: 5 }) }, 202));
  await sending;
  await tick();
  expect(FakeEventSource.all).toHaveLength(sources);
  expect(store.steps.value.map(s => s.seq)).toEqual([3]);
});

test('a second follow-up while one is in flight does nothing', async () => {
  const pending = deferred();
  const { store, calls } = followUpSetup({ post: () => pending.promise });
  await endedAt(store, 3);
  const first = store.followUp('One');
  await store.followUp('Two');
  pending.resolve(json({ task: taskDetail({ status: 'planning', cycle: 2, lastSeq: 5 }) }, 202));
  await first;
  expect(calls.filter(c => c.method === 'POST')).toHaveLength(1);
  expect(calls.find(c => c.method === 'POST')?.body).toEqual({ text: 'One' });
});

test('a refused follow-up re-reads the task, so a task running in another tab shows up', async () => {
  let card = taskDetail({ status: 'done', lastSeq: 3 });
  const { store, calls } = followUpSetup({
    card: () => card,
    post: () => json({ error: { code: 'conflict', message: 'task is running' } }, 409),
  });
  await endedAt(store, 3);
  const reads = calls.filter(c => c.method === 'GET').length;
  card = taskDetail({ status: 'planning', cycle: 2, lastSeq: 5 });
  await expect(store.followUp('More')).rejects.toMatchObject({ code: 'conflict' });
  await tick();
  expect(calls.filter(c => c.method === 'GET').length).toBeGreaterThan(reads);
  expect(store.task.value).toMatchObject({ status: 'planning', cycle: 2 });
  expect(FakeEventSource.last.url).toBe('/api/tasks/task-1/events?after=3');
});

test('a cycle continued elsewhere and already finished: a re-read with newer steps opens the stream again', async () => {
  let card = taskDetail({ status: 'done', lastSeq: 3 });
  const { store } = followUpSetup({ card: () => card });
  await endedAt(store, 3);
  expect(FakeEventSource.all).toHaveLength(1);
  card = taskDetail({ status: 'done', cycle: 2, lastSeq: 9 });
  await store.refresh();
  expect(FakeEventSource.all).toHaveLength(2);
  expect(FakeEventSource.last.url).toBe('/api/tasks/task-1/events?after=3');
  // Поток снова закрылся, а шагов больше не пришло: тот же lastSeq второй раз поток не открывает.
  FakeEventSource.last.emit('end', { status: 'done' });
  await tick();
  await tick();
  expect(FakeEventSource.all).toHaveLength(2);
});

test('an unknown task ends in an error and opens no stream', async () => {
  const { store } = setup([]);
  await store.start();
  expect(store.error.value?.code).toBe('not_found');
  expect(FakeEventSource.all).toHaveLength(0);
});

test('a lost connection re-reads the card at once (it also re-checks the session)', async () => {
  const { store, reads } = setup([taskResponse()]);
  await store.start();
  FakeEventSource.last.fail(0);
  await tick();
  expect(reads()).toBe(2);
});

test('the lost connection is shown only after 5 s without open: the 15-minute close does not flash', async () => {
  const { fetch } = fakeFetch({ 'GET /api/tasks/task-1': () => json(taskResponse()) });
  const offline = manualTimers();
  const store = createTaskStore(
    {
      api: createApi({ fetch }),
      openEvents: opts => openTaskEvents({ ...opts, createSource: url => new FakeEventSource(url) }),
      ...offline,
    },
    'task-1',
  );
  await store.start();
  // Сервер штатно закрыл поток, EventSource переподключился быстрее 5 с: показывать нечего.
  FakeEventSource.last.fail(0);
  expect(offline.delays()).toEqual([5000]);
  expect(store.connected.value).toBe(true);
  FakeEventSource.last.open();
  expect(offline.delays()).toEqual([]);
  expect(store.connected.value).toBe(true);
  // Связи нет 5 с — экран говорит, что переподключается; open снимает пометку.
  FakeEventSource.last.fail(0);
  FakeEventSource.last.fail(0);
  expect(offline.delays()).toEqual([5000]);
  offline.run();
  expect(store.connected.value).toBe(false);
  FakeEventSource.last.open();
  expect(store.connected.value).toBe(true);
  // Уборка снимает отложенную пометку.
  FakeEventSource.last.fail(0);
  store.dispose();
  expect(offline.delays()).toEqual([]);
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

test('a transient failure while re-checking is only a stale card: the stream keeps retrying, reconnect re-reads', async () => {
  const { store, timers, answer, reads } = setupLive();
  await store.start();
  answer(json({ error: { code: 'internal', message: 'boom' } }, 500));
  FakeEventSource.last.fail(2);
  await tick();
  expect(store.error.value).toBeNull();
  expect(store.stale.value?.code).toBe('internal');
  answer(json(taskResponse()));
  timers.run();
  expect(FakeEventSource.all).toHaveLength(2);
  const before = reads();
  FakeEventSource.last.open();
  await tick();
  expect(reads()).toBe(before + 1);
  expect(store.stale.value).toBeNull();
});

test('a failed first load can be retried with start() without leaking a stream', async () => {
  const { store, answer } = setupLive();
  answer(json({ error: { code: 'internal', message: 'boom' } }, 500));
  await store.start();
  expect(store.error.value?.code).toBe('internal');
  expect(FakeEventSource.all).toHaveLength(0);
  answer(json(taskResponse()));
  await store.start();
  expect(store.error.value).toBeNull();
  expect(FakeEventSource.all).toHaveLength(1);
});

test('start() twice opens one stream and reads the card once', async () => {
  const { store, reads } = setupLive();
  await Promise.all([store.start(), store.start()]);
  await store.start();
  expect(reads()).toBe(1);
  expect(FakeEventSource.all).toHaveLength(1);
});

test('a malformed end still re-reads the card', async () => {
  const { store, answer, reads } = setupLive();
  await store.start();
  answer(json(taskResponse({ task: taskDetail({ status: 'done', result: 'ok' }) })));
  FakeEventSource.last.emit('end', { status: 'exploded' });
  await tick();
  expect(reads()).toBe(2);
  expect(store.finished).toBe(true);
});

test('steps that could not be read are counted for the feed', async () => {
  const { store } = setupLive();
  await store.start();
  FakeEventSource.last.emit('step', { seq: 1, nonsense: true }, '1');
  FakeEventSource.last.emitRaw('step', '{not json');
  FakeEventSource.last.emit('step', step(3, { type: 'message', role: 'assistant', text: 'hi' }), '3');
  expect(store.skippedSteps.value).toBe(2);
  expect(store.steps.value.map(s => s.seq)).toEqual([3]);
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
