import { beforeEach, expect, test } from 'bun:test';
import type { StepDto, StreamEnd } from '@agent/shared';
import { openTaskEvents } from '../src/api/events.ts';
import { step, status } from './fixtures.ts';
import { FakeEventSource, manualTimers } from './sse.ts';

beforeEach(() => FakeEventSource.reset());

function open(afterSeq = 0) {
  const timers = manualTimers();
  const steps: number[] = [];
  const ends: StreamEnd[] = [];
  const connection: boolean[] = [];
  const stream = openTaskEvents({
    taskId: 'task 1',
    afterSeq,
    createSource: url => new FakeEventSource(url),
    ...timers,
    onStep: (s: StepDto) => steps.push(s.seq),
    onEnd: end => ends.push(end),
    onConnection: value => connection.push(value),
  });
  return { stream, timers, steps, ends, connection };
}

const message = (seq: number) => step(seq, { type: 'message', role: 'assistant', text: `m${seq}` });

test('steps arrive once each and in order: duplicates and replays are dropped', () => {
  const { steps } = open();
  expect(FakeEventSource.last.url).toBe('/api/tasks/task%201/events?after=0');
  for (const seq of [1, 2, 2, 1, 3]) FakeEventSource.last.emit('step', message(seq), String(seq));
  expect(steps).toEqual([1, 2, 3]);
});

test('end closes the stream for good and reports the final status', () => {
  const { ends, timers } = open();
  FakeEventSource.last.emit('end', { status: 'done' });
  expect(ends).toEqual([{ status: 'done' }]);
  expect(FakeEventSource.last.closed).toBe(true);
  timers.run();
  expect(FakeEventSource.all).toHaveLength(1);
});

test('stream_error: close, wait, reconnect with ?after= the last seq; delays grow and reset on open', () => {
  const { timers, connection } = open(4);
  FakeEventSource.last.emit('step', message(5));
  FakeEventSource.last.emit('stream_error', { code: 'internal', message: 'the stream failed; reconnect' });
  expect(FakeEventSource.last.closed).toBe(true);
  expect(connection).toEqual([false]);
  expect(timers.delays()).toEqual([1000]);
  timers.run();
  expect(FakeEventSource.last.url).toBe('/api/tasks/task%201/events?after=5');
  FakeEventSource.last.emit('stream_error');
  expect(timers.delays()).toEqual([2000]);
  timers.run();
  FakeEventSource.last.open();
  expect(connection).toEqual([false, true]);
  FakeEventSource.last.emit('stream_error');
  expect(timers.delays()).toEqual([1000]);
});

test('a dropped connection that EventSource retries itself is only reported; a refused one is retried by us', () => {
  const { timers, connection } = open();
  FakeEventSource.last.fail(0);
  expect(connection).toEqual([false]);
  expect(timers.delays()).toEqual([]);
  FakeEventSource.last.open();
  FakeEventSource.last.fail(2);
  expect(timers.delays()).toEqual([1000]);
  timers.run();
  expect(FakeEventSource.all).toHaveLength(2);
});

test('close() stops everything, including a pending reconnect', () => {
  const { stream, timers } = open();
  FakeEventSource.last.emit('stream_error');
  stream.close();
  timers.run();
  expect(FakeEventSource.all).toHaveLength(1);
});

test('a malformed step is skipped without breaking the stream', () => {
  const { steps } = open();
  FakeEventSource.last.emit('step', { seq: 1, nonsense: true });
  FakeEventSource.last.emit('step', status(2, 'queued', 'planning'));
  expect(steps).toEqual([2]);
});

test('the server closing the stream without end (15-minute limit) is left to EventSource: no second connection', () => {
  const { steps, timers, connection } = open();
  FakeEventSource.last.emit('step', message(1), '1');
  FakeEventSource.last.fail(0);
  FakeEventSource.last.open();
  // EventSource повторяет шаги после Last-Event-ID; повтор уже показанного отброшен.
  FakeEventSource.last.emit('step', message(1), '1');
  FakeEventSource.last.emit('step', message(2), '2');
  expect(FakeEventSource.all).toHaveLength(1);
  expect(timers.delays()).toEqual([]);
  expect(steps).toEqual([1, 2]);
  expect(connection).toEqual([false, true]);
});

test('late events from a replaced source never schedule a second reconnect', () => {
  const { timers, steps } = open();
  const first = FakeEventSource.last;
  first.emit('stream_error');
  first.emit('stream_error');
  first.fail(2);
  expect(timers.delays()).toEqual([1000]);
  timers.run();
  expect(FakeEventSource.all).toHaveLength(2);
  first.emit('step', message(1));
  first.emit('end', { status: 'done' });
  expect(steps).toEqual([]);
  expect(FakeEventSource.last.closed).toBe(false);
});

test('every refusal by the server is reported, so the app can re-check the session and the task', () => {
  const timers = manualTimers();
  let refusals = 0;
  openTaskEvents({
    taskId: 'task-1',
    createSource: url => new FakeEventSource(url),
    ...timers,
    onStep: () => undefined,
    onEnd: () => undefined,
    onRefused: () => refusals++,
  });
  FakeEventSource.last.fail(2);
  timers.run();
  FakeEventSource.last.fail(2);
  expect(refusals).toBe(2);
  expect(timers.delays()).toEqual([2000]);
});

test('a step that is not JSON is skipped as well', () => {
  const { steps } = open();
  FakeEventSource.last.emitRaw('step', '{not json');
  FakeEventSource.last.emit('step', message(1));
  expect(steps).toEqual([1]);
});
