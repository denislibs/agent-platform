import { describe, expect, test } from 'bun:test';
import { CryptoIds } from '@agent/core';
import { createTestContainer, FixedClock, InMemoryState, InMemoryUnitOfWork } from '@agent/testing';

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

describe('InMemoryUnitOfWork misuse', () => {
  test('a container repository used inside run throws and the run rolls back', async () => {
    const { uow, tasks, memory } = createTestContainer().cradle;
    const userId = memory.seedUser();
    const p = uow.run(async tx => {
      await tx.tasks.create({ userId, prompt: 'kept?' });
      await tasks.countActive(userId); // репозиторий из контейнера, а не tx
    });
    await expect(p).rejects.toThrow(/repository from the container used inside UnitOfWork\.run/);
    expect(await tasks.countActive(userId)).toBe(0);
  });

  test('container repositories keep working outside run, even while a run is in flight', async () => {
    const { uow, tasks, memory } = createTestContainer().cradle;
    const userId = memory.seedUser();
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    let created!: () => void;
    const ready = new Promise<void>(r => (created = r));
    const running = uow.run(async tx => {
      await tx.tasks.create({ userId, prompt: 'x' });
      created();
      await gate;
    });
    await ready; // run уже внутри fn и ждёт gate
    expect(await tasks.countActive(userId)).toBe(1); // другой асинхронный контекст — не ошибка
    release();
    await running;
  });

  test('tx repositories work inside run as before', async () => {
    const { uow, tasks, memory } = createTestContainer().cradle;
    const userId = memory.seedUser();
    await uow.run(async tx => {
      const t = await tx.tasks.create({ userId, prompt: 'x' });
      expect((await tx.tasks.get(t.id))?.prompt).toBe('x');
    });
    expect(await tasks.countActive(userId)).toBe(1);
  });
});
