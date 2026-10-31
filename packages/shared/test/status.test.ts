import { describe, expect, test } from 'bun:test';
import {
  TASK_STATUSES,
  canTransitionTask,
  isTerminalTask,
  SUBTASK_STATUSES,
  canTransitionSubtask,
} from '@agent/shared';

describe('task transitions', () => {
  test.each([
    ['queued', 'planning'],
    ['planning', 'running'],
    ['planning', 'waiting_user'],
    ['running', 'waiting_user'],
    ['waiting_user', 'running'],
    ['waiting_user', 'planning'],
    ['waiting_user', 'finalizing'],
    ['running', 'finalizing'],
    ['finalizing', 'done'],
  ] as const)('%s → %s is allowed', (from, to) => {
    expect(canTransitionTask(from, to)).toBe(true);
  });

  test.each([
    ['queued', 'running'],
    ['done', 'running'],
    ['failed', 'queued'],
    ['cancelled', 'planning'],
    ['running', 'queued'],
  ] as const)('%s → %s is rejected', (from, to) => {
    expect(canTransitionTask(from, to)).toBe(false);
  });

  test('every non-terminal status can fail or be cancelled', () => {
    for (const s of TASK_STATUSES.filter(status => !isTerminalTask(status))) {
      expect(canTransitionTask(s, 'failed')).toBe(true);
      expect(canTransitionTask(s, 'cancelled')).toBe(true);
    }
  });

  test('terminal statuses', () => {
    expect(TASK_STATUSES.filter(isTerminalTask)).toEqual(['done', 'failed', 'cancelled']);
  });
});

describe('subtask transitions', () => {
  test.each([
    ['pending', 'running'],
    ['pending', 'skipped'],
    ['running', 'reviewing'],
    ['running', 'failed'],
    ['reviewing', 'accepted'],
    ['reviewing', 'running'],
    ['reviewing', 'failed'],
  ] as const)('%s → %s is allowed', (from, to) => {
    expect(canTransitionSubtask(from, to)).toBe(true);
  });

  test.each([
    ['accepted', 'running'],
    ['pending', 'accepted'],
    ['skipped', 'running'],
  ] as const)('%s → %s is rejected', (from, to) => {
    expect(canTransitionSubtask(from, to)).toBe(false);
  });

  test('statuses list', () => {
    expect(SUBTASK_STATUSES).toEqual(['pending', 'running', 'reviewing', 'accepted', 'failed', 'skipped']);
  });
});
