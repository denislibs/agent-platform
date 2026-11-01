import { describe, expect, test } from 'bun:test';
import { CallQueue, sequential } from '../src';

/** Промис, который тест завершает вручную. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>(r => setTimeout(r, 0));

describe('sequential', () => {
  test('a call starts only after the previous one has settled', async () => {
    const started: string[] = [];
    const gates = { a: deferred<string>(), b: deferred<string>() };
    const target = {
      async run(name: 'a' | 'b') {
        started.push(name);
        return gates[name].promise;
      },
    };
    const s = sequential(target, new CallQueue());
    const a = s.run('a');
    const b = s.run('b');
    await tick();
    expect(started).toEqual(['a']);
    gates.a.resolve('A');
    expect(await a).toBe('A');
    await tick();
    expect(started).toEqual(['a', 'b']);
    gates.b.resolve('B');
    expect(await b).toBe('B');
  });

  test('a rejected call passes its error to the caller and does not block the next one', async () => {
    const boom = new Error('boom');
    const s = sequential(
      {
        async fail(): Promise<never> {
          throw boom;
        },
        async ok() {
          return 'ok';
        },
      },
      new CallQueue(),
    );
    const failed = s.fail();
    const ok = s.ok();
    await expect(failed).rejects.toBe(boom);
    expect(await ok).toBe('ok');
  });

  test('a method that throws synchronously still yields a rejected promise in the queue', async () => {
    const s = sequential(
      {
        explode(): Promise<void> {
          throw new RangeError('sync');
        },
        async ok() {
          return 1;
        },
      },
      new CallQueue(),
    );
    await expect(s.explode()).rejects.toBeInstanceOf(RangeError);
    expect(await s.ok()).toBe(1);
  });

  test('targets sharing a queue are serialised together', async () => {
    const queue = new CallQueue();
    const log: string[] = [];
    const make = (name: string) => ({
      async work() {
        log.push(`${name}:start`);
        await tick();
        log.push(`${name}:end`);
      },
    });
    const x = sequential(make('x'), queue);
    const y = sequential(make('y'), queue);
    await Promise.all([x.work(), y.work(), x.work()]);
    expect(log).toEqual(['x:start', 'x:end', 'y:start', 'y:end', 'x:start', 'x:end']);
  });

  test('methods keep their receiver, including private state of class instances', async () => {
    class Counter {
      #n = 0;
      private readonly step = 2;
      async inc() {
        this.#n += this.step;
        return this.#n;
      }
    }
    const s = sequential(new Counter(), new CallQueue());
    expect(await Promise.all([s.inc(), s.inc()])).toEqual([2, 4]);
  });

  test('non-function properties pass through and a method keeps its identity', () => {
    const s = sequential({ label: 'L', async m() {} }, new CallQueue());
    expect(s.label).toBe('L');
    expect(s.m).toBe(s.m);
  });
});
