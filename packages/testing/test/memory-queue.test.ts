import { expect, test } from 'bun:test';
import { createTestContainer, InMemoryJobQueue } from '@agent/testing';

test('enqueue keeps jobs in order and ignores a key that is still pending', async () => {
  const q = new InMemoryJobQueue();
  await q.enqueue({ taskId: 't', kind: 'plan', cycle: 1 }, 't.plan.1');
  await q.enqueue({ taskId: 't', kind: 'plan', cycle: 1 }, 't.plan.1');
  await q.enqueue({ taskId: 't', kind: 'execute', cycle: 1 }, 't.execute.3');
  expect(q.jobs.map(j => j.key)).toEqual(['t.plan.1', 't.execute.3']);
});

test('a taken job frees its key', async () => {
  const q = new InMemoryJobQueue();
  await q.enqueue({ taskId: 't', kind: 'plan', cycle: 1 }, 'k');
  expect(q.next()).toEqual({ taskId: 't', kind: 'plan', cycle: 1, key: 'k' });
  await q.enqueue({ taskId: 't', kind: 'plan', cycle: 1 }, 'k');
  expect(q.jobs).toHaveLength(1);
  expect(q.next()?.key).toBe('k');
  expect(q.next()).toBeUndefined();
});

test('the test container registers an in-memory queue', () => {
  expect(createTestContainer().cradle.queue).toBeInstanceOf(InMemoryJobQueue);
});
