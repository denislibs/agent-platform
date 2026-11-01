import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { StepEvents } from '@agent/core';

async function until(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('step events contract: timed out waiting for a notification');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

const taskId = () => crypto.randomUUID();

export function stepEventsContract(
  name: string,
  open: () => Promise<{ events: StepEvents; close(): Promise<void> }>,
): void {
  describe(`step events contract: ${name}`, () => {
    let events: StepEvents;
    let close: () => Promise<void>;

    beforeAll(async () => {
      ({ events, close } = await open());
    });
    afterAll(async () => {
      await close();
    });

    test('a subscriber gets the seqs published for its task, in order', async () => {
      const id = taskId();
      const got: number[] = [];
      const off = await events.subscribe(id, seq => got.push(seq));
      await events.publish(id, 3);
      await events.publish(id, 4);
      await until(() => got.length === 2);
      expect(got).toEqual([3, 4]);
      await off();
    });

    test('notifications of another task are not delivered', async () => {
      const a = taskId();
      const b = taskId();
      const gotA: number[] = [];
      const gotB: number[] = [];
      const offA = await events.subscribe(a, seq => gotA.push(seq));
      const offB = await events.subscribe(b, seq => gotB.push(seq));
      await events.publish(b, 1);
      await until(() => gotB.length === 1);
      // Сторож: у настоящего брокера уведомление чужой задачи могло бы прийти позже, чем проверка. Порядок доставки
      // сохраняется, поэтому всё, что ушло бы A до сторожа, лежит в gotA к моменту его прихода.
      await events.publish(a, 99);
      await until(() => gotA.length > 0);
      expect(gotA).toEqual([99]);
      expect(gotB).toEqual([1]);
      await offA();
      await offB();
    });

    test('every subscriber of a task is notified; one that unsubscribed is not', async () => {
      const id = taskId();
      const one: number[] = [];
      const two: number[] = [];
      const offOne = await events.subscribe(id, seq => one.push(seq));
      const offTwo = await events.subscribe(id, seq => two.push(seq));
      await events.publish(id, 1);
      await until(() => one.length === 1 && two.length === 1);
      await offOne();
      await events.publish(id, 2);
      await until(() => two.length === 2);
      expect(one).toEqual([1]);
      expect(two).toEqual([1, 2]);
      await offTwo();
    });

    test('publishing without subscribers resolves; unsubscribing twice is harmless', async () => {
      await expect(events.publish(taskId(), 1)).resolves.toBeUndefined();
      const off = await events.subscribe(taskId(), () => {});
      await off();
      await expect(off()).resolves.toBeUndefined();
    });
  });
}
