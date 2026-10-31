import { expect, test } from 'bun:test';
import { InvalidTransitionError, NotFoundError } from '@agent/core';

test('InvalidTransitionError carries entity, id and target status', () => {
  const e = new InvalidTransitionError('task', 't1', 'done');
  expect(e).toBeInstanceOf(Error);
  expect(e.name).toBe('InvalidTransitionError');
  expect([e.entity, e.id, e.to]).toEqual(['task', 't1', 'done']);
  expect(e.message).toContain('"done"');
});

test('NotFoundError names the entity and key', () => {
  const e = new NotFoundError('user', 'a@b.c');
  expect(e.name).toBe('NotFoundError');
  expect(e.message).toBe('user a@b.c not found');
});
