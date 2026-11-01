import { describe, expect, test } from 'bun:test';
import { CryptoIds } from '@agent/core';
import { FixedClock, InMemoryState, InMemoryUnitOfWork } from '@agent/testing';

const NESTED = 'UnitOfWork.run cannot be nested: use the tx passed to fn';
const setup = () =>
  new InMemoryUnitOfWork({ memory: new InMemoryState({ clock: new FixedClock(), ids: new CryptoIds() }) });

describe('InMemoryUnitOfWork', () => {
  test('a nested run throws immediately instead of waiting for the outer run', async () => {
    const uow = setup();
    let innerRan = false;
    const outcome = await uow.run(async () => {
      const inner = uow.run(async () => {
        innerRan = true;
      });
      // Если вложенный run встанет в очередь за внешним, он не завершится никогда — победит таймер.
      const timer = Bun.sleep(100).then(() => 'still waiting');
      return Promise.race([inner.then(() => 'resolved'), timer]).catch((err: unknown) => err);
    });
    expect(outcome).toBeInstanceOf(Error);
    expect(outcome).toHaveProperty('message', NESTED);
    expect(innerRan).toBe(false);
  });

  test('concurrent independent runs still queue one after another', async () => {
    const uow = setup();
    const order: string[] = [];
    const job = (name: string) =>
      uow.run(async () => {
        order.push(`${name}:start`);
        await Bun.sleep(5);
        order.push(`${name}:end`);
        return name;
      });
    expect(await Promise.all([job('a'), job('b'), job('c')])).toEqual(['a', 'b', 'c']);
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
  });

  test('a run started after another finished is not mistaken for a nested one', async () => {
    const uow = setup();
    await uow.run(async () => 'first');
    expect(await uow.run(async () => 'second')).toBe('second');
  });
});
