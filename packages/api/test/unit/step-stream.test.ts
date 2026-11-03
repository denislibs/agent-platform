import { describe, expect, test } from 'bun:test';
import type { Step, StepEvents, StepLog } from '@agent/core';
import type { TaskStatus } from '@agent/shared';
import { InMemoryStepLog } from '@agent/testing';
import { streamTaskSteps, type StepSink, type Timers } from '../../src';
import { setupApi, type ApiTest } from './helpers';

const note = (text: string) => ({ type: 'message', role: 'assistant', text }) as const;
const HOUR = 3_600_000;

/** Приёмник для тестов: события строками ('step:2', 'ping', 'end:cancelled'). */
class RecordingSink implements StepSink {
  readonly events: string[] = [];
  closed = false;
  private readonly listeners: Array<() => void> = [];

  onClose(listener: () => void): void {
    this.listeners.push(listener);
  }
  async send(step: Step): Promise<void> {
    this.events.push(`step:${step.seq}`);
  }
  async ping(): Promise<void> {
    this.events.push('ping');
  }
  async end(status: TaskStatus): Promise<void> {
    this.events.push(`end:${status}`);
  }
  close(): void {
    this.closed = true;
    for (const listener of this.listeners) listener();
  }
  steps(): string[] {
    return this.events.filter(e => e.startsWith('step:'));
  }
}

/** Настоящие таймеры со счётом активных: после конца стрима не должно остаться ни одного. */
function countingTimers() {
  const active = new Set<ReturnType<typeof setTimeout>>();
  const timers: Timers = {
    set(fn, ms) {
      const handle = setTimeout(() => {
        active.delete(handle);
        fn();
      }, ms);
      active.add(handle);
      return handle;
    },
    clear(handle) {
      active.delete(handle as ReturnType<typeof setTimeout>);
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  };
  return { timers, active };
}

/** Таймеры, которые срабатывают только по команде теста: fire(ms) запускает все ожидающие с этим интервалом. */
function manualTimers() {
  const pending = new Map<number, { fn: () => void; ms: number }>();
  let next = 0;
  const timers: Timers = {
    set(fn, ms) {
      const id = ++next;
      pending.set(id, { fn, ms });
      return id;
    },
    clear(handle) {
      pending.delete(handle as number);
    },
  };
  const fire = (ms: number) => {
    for (const [id, timer] of pending) {
      if (timer.ms !== ms) continue;
      pending.delete(id);
      timer.fn();
    }
  };
  return { timers, pending, fire };
}

async function until(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await Bun.sleep(2);
  }
}

/** Задача пользователя с шагом 1 (запрос). */
async function newTask(t: ApiTest) {
  const { user } = await t.signIn();
  return t.c.intake.create({ userId: user.id, prompt: 'p' });
}

/** Запись шага мимо публикации: уведомления не будет. */
const appendQuietly = (t: ApiTest, taskId: string, text: string) =>
  new InMemoryStepLog({ memory: t.c.memory }).append({ taskId, agent: 'system', payload: note(text) });

function deps(t: ApiTest, overrides: { steps?: StepLog; stepEvents?: StepEvents } = {}) {
  return {
    tasks: t.c.tasks,
    steps: overrides.steps ?? t.c.steps,
    stepEvents: overrides.stepEvents ?? t.c.stepEvents,
    logger: t.c.logger,
  };
}

describe('streamTaskSteps', () => {
  test('a reopened task: the finished stream ended, a new one from its last seq carries the new cycle', async () => {
    const t = setupApi();
    const { user } = await t.signIn();
    const task = await t.c.intake.create({ userId: user.id, prompt: 'p' });
    await t.c.tasks.transition(task.id, 'cancelled');
    const first = new RecordingSink();
    await streamTaskSteps(deps(t), { taskId: task.id, afterSeq: 0, heartbeatMs: HOUR, sink: first });
    expect(first.events).toEqual(['step:1', 'end:cancelled']);

    await t.c.intake.reopen({ taskId: task.id, userId: user.id, text: 'More' });
    const second = new RecordingSink();
    const done = streamTaskSteps(deps(t), { taskId: task.id, afterSeq: 1, heartbeatMs: HOUR, sink: second });
    await until(() => second.steps().length === 2);
    expect(second.events).toEqual(['step:2', 'step:3']);

    await t.c.tasks.transition(task.id, 'cancelled');
    await t.c.stepEvents.publish(task.id, 3);
    await done;
    expect(second.events.at(-1)).toBe('end:cancelled');
  });

  test('a notification is only a hint: steps are read from the log in seq order, whatever lastSeq it carries', async () => {
    const t = setupApi();
    const task = await newTask(t);
    const sink = new RecordingSink();
    const done = streamTaskSteps(deps(t), { taskId: task.id, afterSeq: 0, heartbeatMs: HOUR, sink });
    await until(() => sink.steps().length === 1);

    // Уведомление «из будущего» и уведомление со старым номером: ни одно не определяет, что отправить.
    await t.c.stepEvents.publish(task.id, 999);
    await Bun.sleep(5);
    expect(sink.steps()).toEqual(['step:1']);
    await appendQuietly(t, task.id, 'a');
    await appendQuietly(t, task.id, 'b');
    await t.c.stepEvents.publish(task.id, 2);
    await until(() => sink.steps().length === 3);
    expect(sink.steps()).toEqual(['step:1', 'step:2', 'step:3']);

    sink.close();
    await done;
  });

  test('reads never overlap: notifications during a read collapse into one more read', async () => {
    const t = setupApi();
    const task = await newTask(t);
    let inFlight = 0;
    let maxInFlight = 0;
    let reads = 0;
    const gate = Promise.withResolvers<void>();
    const slow: StepLog = {
      append: input => t.c.steps.append(input),
      list: async (taskId, opts) => {
        reads++;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          if (reads === 1) await gate.promise;
          return await t.c.steps.list(taskId, opts);
        } finally {
          inFlight--;
        }
      },
    } as StepLog;
    const sink = new RecordingSink();
    const done = streamTaskSteps(deps(t, { steps: slow }), { taskId: task.id, afterSeq: 0, heartbeatMs: HOUR, sink });
    await until(() => reads === 1);

    for (let i = 0; i < 10; i++) await t.c.stepEvents.publish(task.id, i);
    await Bun.sleep(5); // уведомления доставлены, первое чтение всё ещё висит
    expect(reads).toBe(1);
    gate.resolve();
    await until(() => reads === 2);
    await Bun.sleep(20);
    expect({ reads, maxInFlight }).toEqual({ reads: 2, maxInFlight: 1 });
    expect(sink.steps()).toEqual(['step:1']);

    sink.close();
    await done;
  });

  test('a subscribe that hangs does not hold the stream: it polls on the heartbeat and warns', async () => {
    const t = setupApi();
    const task = await newTask(t);
    const hanging: StepEvents = {
      publish: async () => {},
      subscribe: () => new Promise(() => {}),
    };
    const { timers, active } = countingTimers();
    const sink = new RecordingSink();
    const done = streamTaskSteps(deps(t, { stepEvents: hanging }), {
      taskId: task.id,
      afterSeq: 0,
      heartbeatMs: 20,
      subscribeTimeoutMs: 10,
      timers,
      sink,
    });
    await until(() => sink.steps().length === 1);
    expect(t.c.logger.entries).toMatchObject([
      { level: 'warn', message: expect.stringContaining('subscribe'), fields: { taskId: task.id } },
    ]);

    await appendQuietly(t, task.id, 'polled');
    await until(() => sink.steps().length === 2);
    expect(sink.events).toContain('ping');

    sink.close();
    await done;
    expect(active.size).toBe(0);
  });

  test('a failed subscribe is logged and the stream polls on the heartbeat', async () => {
    const t = setupApi();
    const task = await newTask(t);
    const failing: StepEvents = {
      publish: async () => {},
      subscribe: async () => {
        throw new Error('valkey is down');
      },
    };
    const sink = new RecordingSink();
    const done = streamTaskSteps(deps(t, { stepEvents: failing }), {
      taskId: task.id,
      afterSeq: 0,
      heartbeatMs: 20,
      sink,
    });
    await until(() => sink.steps().length === 1);
    await appendQuietly(t, task.id, 'polled');
    await until(() => sink.steps().length === 2);
    expect(t.c.logger.entries).toMatchObject([{ level: 'warn', fields: { taskId: task.id, error: 'valkey is down' } }]);
    sink.close();
    await done;
  });

  test('a subscription that arrives late is used, then released when the client goes away', async () => {
    const t = setupApi();
    const task = await newTask(t);
    const ready = Promise.withResolvers<void>();
    const late: StepEvents = {
      publish: (id, seq) => t.c.stepEvents.publish(id, seq),
      subscribe: async (id, onNotify) => {
        await ready.promise;
        return t.c.stepEvents.subscribe(id, onNotify);
      },
    };
    const sink = new RecordingSink();
    const done = streamTaskSteps(deps(t, { stepEvents: late }), {
      taskId: task.id,
      afterSeq: 0,
      heartbeatMs: HOUR,
      subscribeTimeoutMs: 10,
      sink,
    });
    await until(() => sink.steps().length === 1);
    // Шаг, записанный до того, как подписка заработала: его подберёт перечитывание при готовности подписки.
    await appendQuietly(t, task.id, 'before the subscription');
    ready.resolve();
    await until(() => sink.steps().length === 2);
    expect(t.c.stepEvents.subscribers(task.id)).toBe(1);

    await t.c.steps.append({ taskId: task.id, agent: 'system', payload: note('notified') });
    await until(() => sink.steps().length === 3);

    sink.close();
    await done;
    expect(t.c.stepEvents.subscribers(task.id)).toBe(0);
  });

  test('a subscription that arrives after the stream has ended is released at once', async () => {
    const t = setupApi();
    const task = await newTask(t);
    await t.c.tasks.transition(task.id, 'failed');
    const ready = Promise.withResolvers<void>();
    const late: StepEvents = {
      publish: async () => {},
      subscribe: async (id, onNotify) => {
        await ready.promise;
        return t.c.stepEvents.subscribe(id, onNotify);
      },
    };
    const sink = new RecordingSink();
    await streamTaskSteps(deps(t, { stepEvents: late }), {
      taskId: task.id,
      afterSeq: 0,
      heartbeatMs: HOUR,
      subscribeTimeoutMs: 10,
      sink,
    });
    expect(sink.events).toEqual(['step:1', 'end:failed']);
    ready.resolve();
    await Bun.sleep(5);
    expect(t.c.stepEvents.subscribers(task.id)).toBe(0);
  });

  test('the stream ends without end once maxStreamMs is up, leaving no subscription or timer', async () => {
    const t = setupApi();
    const task = await newTask(t);
    const { timers, pending, fire } = manualTimers();
    const sink = new RecordingSink();
    const done = streamTaskSteps(deps(t), {
      taskId: task.id,
      afterSeq: 0,
      heartbeatMs: HOUR,
      maxStreamMs: 15 * 60_000,
      timers,
      sink,
    });
    await until(() => sink.steps().length === 1);
    expect([...pending.values()].map(p => p.ms).toSorted()).toEqual([HOUR, 15 * 60_000]);

    fire(15 * 60_000);
    await done;
    expect(sink.events).toEqual(['step:1']); // ни end, ни ping
    expect(pending.size).toBe(0);
    expect(t.c.stepEvents.subscribers(task.id)).toBe(0);
    expect((await t.c.tasks.get(task.id))?.status).toBe('queued');
  });

  test('maxStreamMs that runs out mid-read stops before sending the rest', async () => {
    const t = setupApi();
    const task = await newTask(t);
    await appendQuietly(t, task.id, 'a');
    const { timers, fire } = manualTimers();
    const gate = Promise.withResolvers<void>();
    let reads = 0;
    const slow = {
      append: (input: Parameters<StepLog['append']>[0]) => t.c.steps.append(input),
      list: async (taskId: string, o?: { afterSeq?: number }) => {
        const steps = await t.c.steps.list(taskId, o);
        if (++reads === 1) await gate.promise;
        return steps;
      },
    } as StepLog;
    const sink = new RecordingSink();
    const done = streamTaskSteps(deps(t, { steps: slow }), {
      taskId: task.id,
      afterSeq: 0,
      heartbeatMs: HOUR,
      maxStreamMs: 1000,
      timers,
      sink,
    });
    await until(() => reads === 1);
    fire(1000);
    gate.resolve();
    await done;
    expect(sink.events).toEqual([]);
  });

  test('the task status is read before the steps: a terminal commit during the first read does not end early', async () => {
    const t = setupApi();
    const task = await newTask(t);
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    let reads = 0;
    // Первое чтение берёт снимок ленты, затем «зависает»: за это время воркер коммитит последний шаг и финал.
    const racing = {
      append: (input: Parameters<StepLog['append']>[0]) => t.c.steps.append(input),
      list: async (taskId: string, o?: { afterSeq?: number }) => {
        const snapshot = await t.c.steps.list(taskId, o);
        if (++reads === 1) {
          entered.resolve();
          await gate.promise;
        }
        return snapshot;
      },
    } as StepLog;
    const sink = new RecordingSink();
    const done = streamTaskSteps(deps(t, { steps: racing }), {
      taskId: task.id,
      afterSeq: 0,
      heartbeatMs: HOUR,
      sink,
    });
    await entered.promise;
    await t.c.uow.run(async tx => {
      await tx.tasks.transition(task.id, 'cancelled');
      await tx.steps.append({
        taskId: task.id,
        agent: 'user',
        payload: { type: 'status', from: 'queued', to: 'cancelled' },
      });
    });
    gate.resolve();
    await done;
    // Если бы статус читался после шагов, стрим увидел бы cancelled со старым снимком и закончился без шага 2.
    expect(sink.events).toEqual(['step:1', 'step:2', 'end:cancelled']);
  });

  test('nothing is left behind after end: no subscription, no timer', async () => {
    const t = setupApi();
    const task = await newTask(t);
    const { timers, active } = countingTimers();
    const sink = new RecordingSink();
    const done = streamTaskSteps(deps(t), { taskId: task.id, afterSeq: 0, heartbeatMs: HOUR, timers, sink });
    await until(() => sink.steps().length === 1);
    expect(active.size).toBe(1); // ожидание сердцебиения
    await t.c.tasks.transition(task.id, 'cancelled');
    await t.c.stepEvents.publish(task.id, 1);
    await done;
    expect(sink.events).toEqual(['step:1', 'end:cancelled']);
    expect(active.size).toBe(0);
    expect(t.c.stepEvents.subscribers(task.id)).toBe(0);
  });

  test('nothing is left behind after the client goes away mid-wait', async () => {
    const t = setupApi();
    const task = await newTask(t);
    const { timers, active } = countingTimers();
    const sink = new RecordingSink();
    const done = streamTaskSteps(deps(t), { taskId: task.id, afterSeq: 0, heartbeatMs: HOUR, timers, sink });
    await until(() => sink.steps().length === 1);
    sink.close();
    await done;
    expect(active.size).toBe(0);
    expect(t.c.stepEvents.subscribers(task.id)).toBe(0);
    // Шаги после ухода клиента никуда не пишутся.
    await t.c.steps.append({ taskId: task.id, agent: 'system', payload: note('late') });
    await Bun.sleep(5);
    expect(sink.events).toEqual(['step:1']);
  });
});
