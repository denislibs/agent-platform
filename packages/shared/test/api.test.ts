import { describe, expect, test } from 'bun:test';
import {
  ApiErrorSchema,
  CreateTaskBodySchema,
  formatCredits,
  ListTasksQuerySchema,
  MAX_FILES_PER_TASK,
  parseCredits,
  ReplyBodySchema,
  UploadBodySchema,
  wellFormed,
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

describe('parseCredits', () => {
  test('turns credits with up to 3 decimals into integer millicredits', () => {
    expect(parseCredits('10')).toBe(10_000);
    expect(parseCredits('0.5')).toBe(500);
    expect(parseCredits('2.5')).toBe(2500);
    expect(parseCredits('1.234')).toBe(1234);
    expect(parseCredits('0.001')).toBe(1);
    expect(parseCredits('0.1')).toBe(100);
    expect(parseCredits('0.3')).toBe(300);
    expect(parseCredits('1.005')).toBe(1005);
    expect(parseCredits(' 3 ')).toBe(3000);
  });

  test('refuses zero, negatives, finer fractions, other notations and unsafe sizes', () => {
    for (const bad of [
      '0',
      '0.000',
      '-1',
      '+1',
      '1.2345',
      '0.0005',
      'abc',
      '',
      '1e3',
      '.5',
      '1.',
      '1,5',
      '9007199254740993',
      '9007199254741',
    ]) {
      expect(() => parseCredits(bad)).toThrow(RangeError);
    }
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
    expect(ListTasksQuerySchema.safeParse({ before: 'x'.repeat(512) }).success).toBe(true);
    expect(ListTasksQuerySchema.safeParse({ before: 'x'.repeat(513) }).success).toBe(false);
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

test('NUL characters are rejected in the prompt, the reply text and the upload name', () => {
  expect(CreateTaskBodySchema.safeParse({ prompt: 'a\u0000b' }).success).toBe(false);
  expect(ReplyBodySchema.safeParse({ text: 'a\u0000b' }).success).toBe(false);
  expect(UploadBodySchema.safeParse({ name: 'a\u0000.csv', contentType: 'text/csv', size: 1 }).success).toBe(false);
  expect(ReplyBodySchema.safeParse({ text: 'fine' }).success).toBe(true);
});

test('lone UTF-16 surrogates are rejected in the prompt, the reply text and the upload name', () => {
  expect(CreateTaskBodySchema.safeParse({ prompt: 'a\ud800b' }).success).toBe(false);
  expect(ReplyBodySchema.safeParse({ text: 'a\udc00' }).success).toBe(false);
  expect(UploadBodySchema.safeParse({ name: 'a\ud83d.csv', contentType: 'text/csv', size: 1 }).success).toBe(false);
  // Парный суррогат (эмодзи) — корректная строка.
  expect(CreateTaskBodySchema.safeParse({ prompt: 'ok \ud83d\ude00' }).success).toBe(true);
  expect(wellFormed('plain')).toBe(true);
  expect(wellFormed('\ud800')).toBe(false);
});
