import { expect, test } from 'bun:test';
import { jobKey, kindForStatus, sandboxIdFor } from '../../src';

test('job key and sandbox id formats', () => {
  expect(jobKey('t1', 'execute', 12)).toBe('t1.execute.12');
  expect(sandboxIdFor('t1')).toBe('agent-sbx-t1');
});

test('kindForStatus picks the job that moves the task on', () => {
  expect(kindForStatus('queued', null)).toBe('plan');
  expect(kindForStatus('queued', 'plan')).toBe('plan');
  expect(kindForStatus('planning', 'plan')).toBe('plan');
  expect(kindForStatus('running', 'execute')).toBe('execute');
  expect(kindForStatus('running', 'review')).toBe('review');
  expect(kindForStatus('running', null)).toBe('execute');
  expect(kindForStatus('finalizing', 'finalize')).toBe('finalize');
  for (const s of ['waiting_user', 'done', 'failed', 'cancelled'] as const)
    expect(kindForStatus(s, 'execute')).toBeUndefined();
});
