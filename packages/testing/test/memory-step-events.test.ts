import { expect, test } from 'bun:test';
import { InMemoryStepEvents, stepEventsContract } from '@agent/testing';

stepEventsContract('in-memory', async () => ({ events: new InMemoryStepEvents(), close: async () => {} }));

test('the in-memory double records what was published and counts subscribers', async () => {
  const events = new InMemoryStepEvents();
  const off = await events.subscribe('t', () => {});
  expect(events.subscribers('t')).toBe(1);
  await events.publish('t', 4);
  expect(events.published).toEqual([{ taskId: 't', lastSeq: 4 }]);
  await off();
  expect(events.subscribers('t')).toBe(0);
});
