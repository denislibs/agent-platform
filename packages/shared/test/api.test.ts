import { describe, expect, test } from 'bun:test';
import {
  ApiErrorSchema,
  CreateTaskBodySchema,
  formatCredits,
  ListTasksQuerySchema,
  MAX_FILES_PER_TASK,
  UploadBodySchema,
} from '@agent/shared';

describe('formatCredits', () => {
  test('turns millicredits into a decimal string without floating point', () => {
    expect(formatCredits(0)).toBe('0');
    expect(formatCredits(1000)).toBe('1');
    expect(formatCredits(12_345)).toBe('12.345');
    expect(formatCredits(1500)).toBe('1.5');
    expect(formatCredits(5)).toBe('0.005');
    expect(formatCredits(-250)).toBe('-0.25');
  });

  test('rejects a non-integer amount', () => {
    expect(() => formatCredits(1.5)).toThrow(RangeError);
  });
});

describe('API schemas', () => {
  test('a new task needs a non-empty prompt and at most MAX_FILES_PER_TASK uuid file ids', () => {
    expect(CreateTaskBodySchema.parse({ prompt: '  Compare CRMs ' })).toEqual({ prompt: 'Compare CRMs', fileIds: [] });
    expect(CreateTaskBodySchema.safeParse({ prompt: '   ' }).success).toBe(false);
    expect(CreateTaskBodySchema.safeParse({ prompt: 'x', fileIds: ['abc'] }).success).toBe(false);
    const many = Array.from({ length: MAX_FILES_PER_TASK + 1 }, () => crypto.randomUUID());
    expect(CreateTaskBodySchema.safeParse({ prompt: 'x', fileIds: many }).success).toBe(false);
  });

  test('the task list query coerces limit and bounds it', () => {
    expect(ListTasksQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(ListTasksQuerySchema.parse({ limit: '5', before: 'c' })).toEqual({ limit: 5, before: 'c' });
    expect(ListTasksQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(ListTasksQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
  });

  test('an upload declares a name, a plain mime type and a positive integer size', () => {
    expect(UploadBodySchema.safeParse({ name: 'a.csv', contentType: 'text/csv', size: 3 }).success).toBe(true);
    expect(UploadBodySchema.safeParse({ name: 'a.csv', contentType: 'text/csv; charset=utf-8', size: 3 }).success).toBe(
      false,
    );
    expect(UploadBodySchema.safeParse({ name: 'a.csv', contentType: 'text/csv', size: 0 }).success).toBe(false);
    expect(UploadBodySchema.safeParse({ name: '', contentType: 'text/csv', size: 1 }).success).toBe(false);
  });

  test('an error body has a known code and a message', () => {
    expect(ApiErrorSchema.safeParse({ error: { code: 'not_found', message: 'task not found' } }).success).toBe(true);
    expect(ApiErrorSchema.safeParse({ error: { code: 'teapot', message: 'x' } }).success).toBe(false);
  });
});
