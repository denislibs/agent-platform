import { expect, test } from 'bun:test';
import { InvalidTransitionError, LimitExceededError, NotFoundError, SandboxError, SearchError } from '@agent/core';

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

test('SandboxError carries a machine-readable code', () => {
  const e = new SandboxError('not_running', 'sandbox x is stopped');
  expect(e).toBeInstanceOf(Error);
  expect(e.name).toBe('SandboxError');
  expect(e.code).toBe('not_running');
  expect(e.message).toBe('sandbox x is stopped');
});

test('SearchError carries a code and retryability', () => {
  const e = new SearchError('rate_limited', 'slow down', true);
  expect(e.name).toBe('SearchError');
  expect([e.code, e.retryable]).toEqual(['rate_limited', true]);
  expect(new SearchError('invalid_query', 'empty').retryable).toBe(false);
});

test('LimitExceededError names the limit', () => {
  const e = new LimitExceededError('active_tasks', 'at most 2 active tasks');
  expect(e).toBeInstanceOf(Error);
  expect(e).toMatchObject({ name: 'LimitExceededError', limit: 'active_tasks', message: 'at most 2 active tasks' });
});
