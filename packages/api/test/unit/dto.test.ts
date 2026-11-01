import { describe, expect, test } from 'bun:test';
import type { FileRecord, Step, Subtask, Task } from '@agent/core';
import { FileDtoSchema, StepDtoSchema, SubtaskDtoSchema, TaskDetailSchema } from '@agent/shared';
import { sanitizeReason, toFileDto, toStepDto, toSubtaskDto, toTaskDetail } from '../../src';

describe('sanitizeReason', () => {
  test('replaces absolute host paths and control characters', () => {
    expect(sanitizeReason('ENOENT: open /Users/denis/agent/data/x.json\u0000 failed')).toBe(
      'ENOENT: open <path> failed',
    );
    expect(sanitizeReason('daemon: dial unix /var/run/docker.sock: connect: refused')).toBe(
      'daemon: dial unix <path>: connect: refused',
    );
  });

  test('replaces paths with non-ASCII segments', () => {
    expect(sanitizeReason('open /Users/денис/проект/x.json failed')).toBe('open <path> failed');
  });

  test('keeps short codes, relative paths and single segments', () => {
    expect(sanitizeReason('wait_timeout')).toBe('wait_timeout');
    expect(sanitizeReason('missing outputs/report.csv in /tmp')).toBe('missing outputs/report.csv in /tmp');
  });

  test('caps the length at 200 characters without splitting a character', () => {
    const long = 'я'.repeat(300);
    const out = sanitizeReason(long);
    expect(Array.from(out)).toHaveLength(200);
    expect(out.endsWith('…')).toBe(true);
    const emoji = sanitizeReason('😀'.repeat(300));
    expect(Array.from(emoji)).toHaveLength(200);
    expect(emoji.isWellFormed()).toBe(true);
  });

  test('lone surrogates never reach the output', () => {
    const out = sanitizeReason(`bad \ud800 and \udc00 text ${'x'.repeat(300)}`);
    expect(out.isWellFormed()).toBe(true);
    expect(out.startsWith('bad')).toBe(true);
    expect(sanitizeReason('\ud83d')).toBe('');
  });

  test('a huge input is cut before the regular expressions run', () => {
    const started = performance.now();
    const out = sanitizeReason(`${'/a'.repeat(5_000_000)}`);
    expect(performance.now() - started).toBeLessThan(500);
    expect(Array.from(out).length).toBeLessThanOrEqual(200);
    expect(sanitizeReason(`${'x'.repeat(10_000)}/Users/me/app`)).toBe(`${'x'.repeat(199)}…`);
  });

  test('control characters and line breaks collapse to single spaces', () => {
    expect(sanitizeReason('a\r\nb\tc\u001b[31md\u007fe')).toBe('a b c [31md e');
  });
});

const baseStep = { id: 'x', taskId: 't', subtaskId: null, seq: 3, tokensIn: 0, tokensOut: 0, createdAt: new Date(0) };

test('toStepDto cleans the reason of status steps and leaves other payloads as they are', () => {
  const failed: Step = {
    ...baseStep,
    agent: 'system',
    type: 'status',
    payload: { type: 'status', from: 'running', to: 'failed', reason: 'boom at /home/agent/app/src/x.ts' },
  };
  const dto = StepDtoSchema.parse(toStepDto(failed));
  expect(dto).toEqual({
    seq: 3,
    subtaskId: null,
    agent: 'system',
    type: 'status',
    payload: { type: 'status', from: 'running', to: 'failed', reason: 'boom at <path>' },
    tokensIn: 0,
    tokensOut: 0,
    createdAt: '1970-01-01T00:00:00.000Z',
  });
  const message: Step = {
    ...baseStep,
    agent: 'user',
    type: 'message',
    payload: { type: 'message', role: 'user', text: '/a/b/c' },
  };
  expect(toStepDto(message).payload).toEqual({ type: 'message', role: 'user', text: '/a/b/c' });
});

test('toStepDto keeps a status step without a reason free of the reason key', () => {
  const step: Step = {
    ...baseStep,
    agent: 'system',
    type: 'status',
    payload: { type: 'status', from: 'queued', to: 'planning' },
  };
  expect('reason' in toStepDto(step).payload).toBe(false);
});

test('toStepDto strips unknown payload keys and replaces an unreadable payload', () => {
  const message = {
    ...baseStep,
    agent: 'user',
    type: 'message',
    payload: { type: 'message', role: 'user', text: 'hi', internalPath: '/srv/x/y' },
  } as unknown as Step;
  expect(toStepDto(message).payload).toEqual({ type: 'message', role: 'user', text: 'hi' });
  const status = {
    ...baseStep,
    agent: 'system',
    type: 'status',
    payload: { type: 'status', from: 'running', to: 'failed', reason: 'at /a/b/c', leak: 1 },
  } as unknown as Step;
  expect(toStepDto(status).payload).toEqual({ type: 'status', from: 'running', to: 'failed', reason: 'at <path>' });
  const legacy = { ...baseStep, agent: 'system', type: 'status', payload: { type: 'status' } } as unknown as Step;
  const dto = StepDtoSchema.parse(toStepDto(legacy));
  expect(dto.type).toBe('message');
});

test('toStepDto does not expose the internal step and task ids', () => {
  const step: Step = {
    ...baseStep,
    agent: 'user',
    type: 'message',
    payload: { type: 'message', role: 'user', text: 'hi' },
  };
  expect(Object.keys(toStepDto(step)).toSorted()).toEqual(
    ['agent', 'createdAt', 'payload', 'seq', 'subtaskId', 'tokensIn', 'tokensOut', 'type'].toSorted(),
  );
});

const task: Task = {
  id: 'task-1',
  userId: 'user-1',
  prompt: 'p',
  status: 'running',
  currentKind: 'execute',
  partial: false,
  stopReason: null,
  sandboxId: 'sandbox-secret',
  tokensUsed: 5,
  activeMs: 99,
  lastSeq: 7,
  result: null,
  createdAt: new Date(0),
  updatedAt: new Date(1000),
  finishedAt: null,
};

test('toTaskDetail projects the public fields only', () => {
  const dto = toTaskDetail(task);
  expect(TaskDetailSchema.parse(dto)).toEqual(dto);
  expect(Object.keys(dto).toSorted()).toEqual(
    [
      'createdAt',
      'finishedAt',
      'id',
      'lastSeq',
      'partial',
      'prompt',
      'result',
      'status',
      'stopReason',
      'tokensUsed',
      'updatedAt',
    ].toSorted(),
  );
});

test('toSubtaskDto drops taskId, dependsOn and timestamps', () => {
  const subtask: Subtask = {
    id: 's1',
    taskId: 'task-1',
    idx: 0,
    goal: 'g',
    context: 'c',
    doneCriteria: 'd',
    expectedOutputs: ['a.csv'],
    status: 'pending',
    attempts: 0,
    report: null,
    dependsOn: [1],
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  const dto = toSubtaskDto(subtask);
  expect(SubtaskDtoSchema.parse(dto)).toEqual(dto);
  expect('taskId' in dto || 'dependsOn' in dto).toBe(false);
});

test('toFileDto hides the storage key and the owner and links to the API download', () => {
  const file: FileRecord = {
    id: 'f1',
    taskId: 'task-1',
    userId: 'user-1',
    kind: 'output',
    path: 'out/a.csv',
    storageKey: 'outputs/user-1/secret-key',
    size: 3,
    mime: 'text/csv',
    createdAt: new Date(0),
  };
  const dto = toFileDto(file);
  expect(FileDtoSchema.parse(dto)).toEqual(dto);
  expect(dto.url).toBe('/api/files/f1');
  expect(JSON.stringify(dto)).not.toContain('secret-key');
  expect('userId' in dto || 'taskId' in dto || 'storageKey' in dto).toBe(false);
});
