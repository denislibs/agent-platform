import { expect, test } from 'bun:test';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { InvalidTransitionError, LimitExceededError, NotFoundError } from '@agent/core';
import { ApiError, mapError } from '../../src';

test('core errors map to typed API errors', () => {
  expect(mapError(new NotFoundError('task', 'secret-id'))).toEqual({
    status: 404,
    body: { error: { code: 'not_found', message: 'task not found' } },
  });
  expect(mapError(new LimitExceededError('credits', 'not enough credits'))).toMatchObject({
    status: 402,
    body: { error: { code: 'insufficient_credits' } },
  });
  expect(mapError(new LimitExceededError('active_tasks', 'at most 2'))).toMatchObject({
    status: 429,
    body: { error: { code: 'too_many_active_tasks', message: 'at most 2' } },
  });
  expect(mapError(new InvalidTransitionError('task', 't', 'running'))).toMatchObject({
    status: 409,
    body: { error: { code: 'conflict' } },
  });
});

test('an ApiError keeps its status, code and message; anything else is a bare 500', () => {
  expect(mapError(new ApiError(409, 'upload_incomplete', 'upload a.csv first'))).toEqual({
    status: 409,
    body: { error: { code: 'upload_incomplete', message: 'upload a.csv first' } },
  });
  expect(mapError(new Error('/Users/me/secret'))).toEqual({
    status: 500,
    body: { error: { code: 'internal', message: 'internal error' } },
  });
});

const secret = (status: ContentfulStatusCode) => new HTTPException(status, { message: '/Users/me/secret' });

test('a Hono HTTPException maps by status with a fixed message, never its own text', () => {
  expect(mapError(secret(400))).toEqual({
    status: 400,
    body: { error: { code: 'bad_request', message: 'bad request' } },
  });
  expect(mapError(secret(401)).body.error.code).toBe('unauthorized');
  expect(mapError(secret(404)).body.error.code).toBe('not_found');
  expect(mapError(secret(413))).toEqual({
    status: 413,
    body: { error: { code: 'payload_too_large', message: 'payload too large' } },
  });
  expect(mapError(secret(418))).toMatchObject({ status: 418, body: { error: { code: 'bad_request' } } });
  expect(mapError(secret(503))).toEqual({
    status: 500,
    body: { error: { code: 'internal', message: 'internal error' } },
  });
});
